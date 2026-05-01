// Google authorization utilities for custom API tokens
// Stores context reference and provides token read/write operations
import * as vscode from 'vscode'

const GOOGLE_API_KEY_SECRET_KEY = 'reliefpilot.google.apiKey'
const GOOGLE_SEARCH_ENGINE_ID_SECRET_KEY = 'reliefpilot.google.searchEngineId'

let extensionContext: vscode.ExtensionContext | undefined

export function initGoogleAuth(context: vscode.ExtensionContext): void {
    extensionContext = context
}

async function getSecret(key: string): Promise<string | undefined> {
    if (!extensionContext) return undefined
    const value = await extensionContext.secrets.get(key)
    return value && value.trim().length > 0 ? value.trim() : undefined
}

async function updateSecret(options: {
    key: string
    title: string
    placeHolder: string
    password?: boolean
}): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        title: options.title,
        placeHolder: options.placeHolder,
        ignoreFocusOut: true,
        password: options.password ?? false,
    })
    if (input === undefined) return undefined

    const trimmed = input.trim()
    if (!extensionContext) return undefined

    if (trimmed.length === 0) {
        await extensionContext.secrets.delete(options.key)
        void vscode.window.showInformationMessage(`Google API token \`${options.title}\` deleted.`)
        return undefined
    }

    await extensionContext.secrets.store(options.key, trimmed)
    return trimmed
}

export async function setupOrUpdateGoogleApiKey(): Promise<string | undefined> {
    try {
        const value = await updateSecret({
            key: GOOGLE_API_KEY_SECRET_KEY,
            title: 'GOOGLE_API_KEY',
            placeHolder: 'Paste your Google API key (GOOGLE_API_KEY)',
            password: true,
        })
        if (value) {
            void vscode.window.showInformationMessage('Google API token `GOOGLE_API_KEY` stored securely.')
        }
        return value
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Failed to store GOOGLE_API_KEY token: ${message}`)
        return undefined
    }
}

export async function setupOrUpdateGoogleSearchEngineId(): Promise<string | undefined> {
    try {
        const value = await updateSecret({
            key: GOOGLE_SEARCH_ENGINE_ID_SECRET_KEY,
            title: 'GOOGLE_SEARCH_ENGINE_ID',
            placeHolder: 'Paste your Google Search Engine ID (GOOGLE_SEARCH_ENGINE_ID)',
            password: false,
        })
        if (value) {
            void vscode.window.showInformationMessage('Google API token `GOOGLE_SEARCH_ENGINE_ID` stored securely.')
        }
        return value
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Failed to store GOOGLE_SEARCH_ENGINE_ID token: ${message}`)
        return undefined
    }
}

export async function hasGoogleApiKey(): Promise<boolean> {
    return !!(await getSecret(GOOGLE_API_KEY_SECRET_KEY))
}

export async function hasGoogleSearchEngineId(): Promise<boolean> {
    return !!(await getSecret(GOOGLE_SEARCH_ENGINE_ID_SECRET_KEY))
}

export async function getGoogleApiKey(): Promise<string | undefined> {
    return await getSecret(GOOGLE_API_KEY_SECRET_KEY)
}

export async function getGoogleSearchEngineId(): Promise<string | undefined> {
    return await getSecret(GOOGLE_SEARCH_ENGINE_ID_SECRET_KEY)
}
