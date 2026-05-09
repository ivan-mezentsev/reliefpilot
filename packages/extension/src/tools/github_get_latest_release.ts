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

export interface GithubGetLatestReleaseInput {
    owner: string
    repo: string
}

interface GithubReleaseItem {
    tag_name: string
    name: string | null
    draft: boolean
    prerelease: boolean
    created_at: string
    published_at: string | null
    html_url: string
}

function normalizeString(name: string, raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error(`Missing required parameter: ${name}`)
    }
    return raw.trim()
}

function formatRelease(owner: string, repo: string, r: GithubReleaseItem): string {
    const lines: string[] = []
    const header = `Latest GitHub Release for ${owner}/${repo}`
    lines.push(header)
    lines.push('')
    lines.push(`- Tag: ${r.tag_name}`)
    if (r.name) lines.push(`- Name: ${r.name}`)
    lines.push(`- Draft: ${r.draft}`)
    lines.push(`- Pre-release: ${r.prerelease}`)
    lines.push(`- Published: ${r.published_at ?? 'N/A'}`)
    lines.push(`- URL: ${r.html_url}`)
    return lines.join('\n')
}

async function getLatestRelease(owner: string, repo: string, token: CancellationToken): Promise<GithubReleaseItem | undefined> {
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`
    const url = new URL(base)
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url.toString(), controller.signal)
        if (!res.ok) return undefined
        const data = await res.json()
        return data as GithubReleaseItem
    } finally {
        sub.dispose()
    }
}

export class GithubGetLatestReleaseTool implements LanguageModelTool<GithubGetLatestReleaseInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubGetLatestReleaseInput>,
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
            const item = await getLatestRelease(owner, repo, token)
            if (!item) {
                throw new Error('Failed to retrieve latest release data from GitHub')
            }
            const body = formatRelease(owner, repo, item)
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createGithubContentSession(uid, 'github_get_latest_release')
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
                new vscode.LanguageModelTextPart(`github_get_latest_release error: ${message}`),
            ])
        } finally {
            statusBarActivity.end('github')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GithubGetLatestReleaseInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('github')
        const owner = options.input?.owner ?? '<missing-owner>'
        const repo = options.input?.repo ?? '<missing-repo>'
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **github_get_latest_release**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Repo: \`${owner}/${repo}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
