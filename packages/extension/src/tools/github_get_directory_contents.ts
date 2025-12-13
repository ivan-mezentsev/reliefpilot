import { randomUUID } from 'node:crypto'
import type {
    CancellationToken,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    PreparedToolInvocation,
} from 'vscode'
import * as vscode from 'vscode'
import { env } from '../utils/env'
import { fetchGitHub } from '../utils/github_auth'
import { createGithubContentSession, finalizeGithubSession } from '../utils/github_content_sessions'
import { statusBarActivity } from '../utils/statusBar'

export interface GithubGetDirectoryContentsInput {
    owner: string
    repo: string
    path?: string
    ref?: string
}

type GithubContentItemType = 'file' | 'dir' | 'symlink' | 'submodule' | string

interface GithubContentResponseItem {
    type: GithubContentItemType
    size?: number
    name: string
    path: string
    sha: string
    url: string
    html_url: string
    git_url?: string
    download_url?: string | null
}

function normalizeString(name: string, raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error(`Missing required parameter: ${name}`)
    }
    return raw.trim()
}

function normalizeOptionalPath(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    let t = raw.trim()
    if (t.length === 0) return undefined

    // Normalize common user inputs:
    // - Leading slashes are not part of the GitHub "contents" path
    // - Trailing slashes may trigger API canonicalization/redirect that can drop the `ref` query
    // - A pure "/" (or multiple slashes) should mean repository root
    t = t.replace(/^\/+/, '')
    t = t.replace(/\/+$/, '')

    return t.length === 0 ? undefined : t
}

function normalizeRef(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    const t = raw.trim()
    return t.length === 0 ? undefined : t
}

function buildContentsUrl(owner: string, repo: string, path: string | undefined, ref: string | undefined): string {
    const baseRepo = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`
    const base = path
        ? `${baseRepo}/${path.split('/').map(encodeURIComponent).join('/')}`
        : baseRepo
    const url = new URL(base)
    if (ref) url.searchParams.set('ref', ref)
    return url.toString()
}

async function getDirectoryContents(
    owner: string,
    repo: string,
    path: string | undefined,
    ref: string | undefined,
    token: CancellationToken,
): Promise<GithubContentResponseItem[]> {
    const url = buildContentsUrl(owner, repo, path, ref)
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url, controller.signal)
        if (!res.ok) {
            const txt = await res.text().catch(() => '')
            throw new Error(txt || `${res.status} ${res.statusText}`)
        }
        const data = await res.json()

        if (Array.isArray(data)) {
            return data as GithubContentResponseItem[]
        }

        const t = (data as any)?.type
        if (t === 'file') {
            throw new Error('The provided path points to a file. Use github_get_file_contents instead.')
        }
        if (t) {
            throw new Error(`The provided path is not a directory (type: ${String(t)})`)
        }

        throw new Error('Unexpected response from GitHub Contents API (expected an array for directory listing)')
    } finally {
        sub.dispose()
    }
}

function formatEntry(i: GithubContentResponseItem): string {
    const lines: string[] = []
    lines.push(`- Name: ${i.name}`)
    lines.push(`- Path: ${i.path}`)
    lines.push(`- Type: ${i.type}`)
    if (typeof i.size === 'number') lines.push(`- Size: ${i.size} bytes`)
    lines.push(`- SHA: ${i.sha}`)
    lines.push(`- URL: ${i.html_url}`)
    return lines.join('\n')
}

function formatDirectoryListing(
    owner: string,
    repo: string,
    path: string | undefined,
    ref: string | undefined,
    items: GithubContentResponseItem[],
): string {
    const shownPath = path ?? '/'
    const headerLines: string[] = []
    headerLines.push('GitHub Directory Contents')
    headerLines.push('')
    headerLines.push(`- Repo: ${owner}/${repo}`)
    headerLines.push(`- Path: ${shownPath}`)
    if (ref) headerLines.push(`- Ref: ${ref}`)
    headerLines.push(`- Entries: ${items.length}`)

    if (!items || items.length === 0) {
        return headerLines.join('\n') + '\n\n(empty directory)'
    }

    return headerLines.join('\n') + '\n\n' + items.map(formatEntry).join('\n----------\n')
}

export class GithubGetDirectoryContentsTool implements LanguageModelTool<GithubGetDirectoryContentsInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubGetDirectoryContentsInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
        const session = createGithubContentSession(uid, 'github_get_directory_contents')

        try {
            const owner = normalizeString('owner', options.input?.owner)
            const repo = normalizeString('repo', options.input?.repo)
            const path = normalizeOptionalPath(options.input?.path)
            const ref = normalizeRef(options.input?.ref)

            const items = await getDirectoryContents(owner, repo, path, ref, token)
            const body = formatDirectoryListing(owner, repo, path, ref, items)

            session.contentBuffer = body
            try { session.contentEmitter.fire(session.contentBuffer) } catch { /* ignore */ }

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const errorBody = `github_get_directory_contents error: ${message}`
            session.contentBuffer = errorBody
            try { session.contentEmitter.fire(session.contentBuffer) } catch { /* ignore */ }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(errorBody),
            ])
        } finally {
            finalizeGithubSession(uid)
            statusBarActivity.end('github')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GithubGetDirectoryContentsInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('github')
        const owner = options.input?.owner ?? '<missing-owner>'
        const repo = options.input?.repo ?? '<missing-repo>'
        const p = normalizeOptionalPath(options.input?.path) ?? '/'
        const ref = options.input?.ref

        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true

        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown('Relief Pilot · **github_get_directory_contents**\n')
        md.appendMarkdown(`- Repo: \`${owner}/${repo}\`  \n`)
        md.appendMarkdown(`- Path: \`${p}\`  \n`)
        if (ref) md.appendMarkdown(`- Ref: \`${ref}\`  \n`)

        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
