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
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { fetchGitHub } from '../utils/github_auth'
import { createGithubContentSession, finalizeGithubSession } from '../utils/github_content_sessions'
import { statusBarActivity } from '../utils/statusBar'

export interface GithubGetFileContentsInput {
    owner: string
    repo: string
    path: string
    ref?: string
}

interface GithubContentResponseFile {
    type: 'file'
    encoding?: 'base64' | string
    size: number
    name: string
    path: string
    content?: string
    sha: string
    url: string
    html_url: string
}

function normalizeString(name: string, raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error(`Missing required parameter: ${name}`)
    }
    return raw.trim()
}

function normalizeRef(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    const t = raw.trim()
    return t.length === 0 ? undefined : t
}

function decodeBase64(b64?: string): string | undefined {
    if (!b64) return undefined
    try {
        // GitHub may include line breaks in base64 content
        const normalized = b64.replace(/\n/g, '')
        return Buffer.from(normalized, 'base64').toString('utf8')
    } catch { return undefined }
}

async function getFile(owner: string, repo: string, path: string, ref: string | undefined, token: CancellationToken): Promise<GithubContentResponseFile | undefined> {
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`
    const url = new URL(base)
    if (ref) url.searchParams.set('ref', ref)
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url.toString(), controller.signal)
        if (!res.ok) return undefined
        const data = await res.json()
        if (!data || data.type !== 'file') return undefined
        return data as GithubContentResponseFile
    } finally {
        sub.dispose()
    }
}

export class GithubGetFileContentsTool implements LanguageModelTool<GithubGetFileContentsInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubGetFileContentsInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            // Halt for Feedback gating: must happen before any GitHub API requests.
            let state = haltForFeedbackController.getSnapshot()
            if (state.kind === 'paused') {
                state = await haltForFeedbackController.waitUntilNotPaused(token)
            }

            // Respect VS Code cancellation while waiting in paused state.
            if (token.isCancellationRequested) {
                // Mimic fetch abort error to preserve existing cancellation behavior as closely as possible.
                throw (typeof DOMException !== 'undefined')
                    ? new DOMException('This operation was aborted', 'AbortError')
                    : new Error('This operation was aborted')
            }

            if (state.kind === 'declined') {
                haltForFeedbackController.takeDeclineAndReset()
                throw new Error('Tool execution was declined by the user. Feedback: ' + state.feedback)
            }

            const owner = normalizeString('owner', options.input?.owner)
            const repo = normalizeString('repo', options.input?.repo)
            const p = normalizeString('path', options.input?.path)
            const ref = normalizeRef(options.input?.ref)
            const resp = await getFile(owner, repo, p, ref, token)
            if (!resp) {
                throw new Error('Failed to retrieve file content from GitHub (not found or unsupported type)')
            }
            let content = ''
            if (resp.encoding === 'base64' && resp.content) {
                const decoded = decodeBase64(resp.content)
                if (decoded !== undefined) content = decoded
            }
            if (!content) {
                throw new Error('Unsupported or empty file content returned by GitHub API')
            }
            const header = `# ${resp.name}\n\nRepository: ${owner}/${repo}\nPath: ${resp.path}${ref ? `\nRef: ${ref}` : ''}\nSize: ${resp.size} bytes\nSHA: ${resp.sha}\nURL: ${resp.html_url}`
            const body = `${header}\n\n\n\u2063\n\n\n` + '~~~\n' + content + '\n~~~'
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createGithubContentSession(uid, 'github_get_file_contents')
            session.contentBuffer = body
            try { session.contentEmitter.fire(session.contentBuffer) } catch { /* ignore */ }
            finalizeGithubSession(uid)
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                // Preserve exact error format
                throw new Error(message)
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`github_get_file_contents error: ${message}`),
            ])
        } finally {
            statusBarActivity.end('github')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GithubGetFileContentsInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('github')
        const owner = options.input?.owner ?? '<missing-owner>'
        const repo = options.input?.repo ?? '<missing-repo>'
        const p = options.input?.path ?? '<missing-path>'
        const ref = options.input?.ref
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **github_get_file_contents**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Repo: \`${owner}/${repo}\`  \n`)
        md.appendMarkdown(`• Path: \`${p}\`  \n`)
        if (ref) md.appendMarkdown(`• Ref: \`${ref}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
