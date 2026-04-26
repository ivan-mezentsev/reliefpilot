// GitHub authorization utilities
// Stores context reference and provides token read/write/delete operations
import * as vscode from 'vscode'

const GITHUB_TOKEN_SECRET_KEY = 'reliefpilot.github.apiToken'

let extensionContext: vscode.ExtensionContext | undefined

export function initGitHubAuth(context: vscode.ExtensionContext): void {
    extensionContext = context
}

async function getToken(): Promise<string | undefined> {
    if (!extensionContext) return undefined
    const token = await extensionContext.secrets.get(GITHUB_TOKEN_SECRET_KEY)
    return token && token.trim().length > 0 ? token.trim() : undefined
}

async function deleteToken(): Promise<void> {
    if (!extensionContext) return
    await extensionContext.secrets.delete(GITHUB_TOKEN_SECRET_KEY)
}

async function updateToken(): Promise<string | undefined> {
    const token = await vscode.window.showInputBox({
        title: 'GitHub Personal Access Token',
        placeHolder: 'Paste your GitHub token (PAT)',
        ignoreFocusOut: true,
        password: true,
        validateInput: (v) => (v && v.trim().length > 0 ? undefined : 'Token is required'),
    })
    if (!token) return undefined
    const trimmed = token.trim()
    if (!extensionContext) return undefined
    await extensionContext.secrets.store(GITHUB_TOKEN_SECRET_KEY, trimmed)
    return trimmed
}

export async function setupOrUpdateGitHubToken(): Promise<void> {
    try {
        const token = await updateToken()
        if (token) {
            void vscode.window.showInformationMessage('GitHub API token stored securely.')
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Failed to store GitHub token: ${message}`)
    }
}

export async function hasGitHubToken(): Promise<boolean> {
    return !!(await getToken())
}

async function handleAuthError(): Promise<string | undefined> {
    const items: vscode.QuickPickItem[] = [
        {
            label: 'Update API-token `github`',
            description: 'Change stored GitHub API token',
        },
        {
            label: 'Delete API-token `github`',
            description: 'Remove stored token and continue without authorization',
        },
    ]

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'GitHub API token is invalid',
        ignoreFocusOut: true,
    })
    if (!pick) return undefined

    if (pick.label === 'Update API-token `github`') {
        return await updateToken()
    } else {
        await deleteToken()
        return undefined
    }
}

interface FetchGitHubOptions {
    returnRateLimitResponse?: boolean
}

async function isRateLimitResponse(res: Response): Promise<boolean> {
    if (res.status !== 403 && res.status !== 429) return false
    if (res.headers.get('retry-after')) return true
    if (res.headers.get('x-ratelimit-remaining') === '0') return true
    const text = await res.clone().text().catch(() => '')
    return text.toLowerCase().includes('rate limit')
}

export async function fetchGitHub(
    url: string,
    signal?: AbortSignal,
    accept?: string,
    options?: FetchGitHubOptions,
): Promise<Response> {
    while (true) {
        const token = await getToken()
        const headers: Record<string, string> = {
            'User-Agent': 'reliefpilot-extension',
            'Accept': accept ?? 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28',
        }
        if (token) {
            headers['Authorization'] = `Bearer ${token}`
        }

        const res = await fetch(url, { method: 'GET', signal, headers })

        if (options?.returnRateLimitResponse && await isRateLimitResponse(res)) {
            return res
        }

        if (res.status === 401 || res.status === 403) {
            if (!token) {
                return res
            }
            const newToken = await handleAuthError()
            if (newToken === undefined && !(await getToken())) {
                // User deleted token or canceled - retry without token
                continue
            }
            continue
        }

        return res
    }
}
