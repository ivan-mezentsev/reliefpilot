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

export interface GithubListReleasesInput {
    owner: string
    repo: string
    per_page?: number
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

function normalizePerPage(raw?: number): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
    const v = Math.trunc(raw)
    return v > 100 ? 100 : v
}

function formatRelease(r: GithubReleaseItem): string {
    const lines: string[] = []
    lines.push(`- Tag: ${r.tag_name}`)
    if (r.name) lines.push(`- Name: ${r.name}`)
    lines.push(`- Draft: ${r.draft}`)
    lines.push(`- Pre-release: ${r.prerelease}`)
    lines.push(`- Published: ${r.published_at ?? 'N/A'}`)
    lines.push(`- URL: ${r.html_url}`)
    return lines.join('\n')
}

function formatResults(owner: string, repo: string, items: GithubReleaseItem[]): string {
    if (!items || items.length === 0) {
        return `No releases found for ${owner}/${repo}.`
    }
    const header = `GitHub Releases for ${owner}/${repo} (showing ${items.length})`
    return `${header}\n\n` + items.map(formatRelease).join('\n----------\n')
}

async function listReleases(owner: string, repo: string, perPage: number | undefined, token: CancellationToken): Promise<GithubReleaseItem[] | undefined> {
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`
    const url = new URL(base)
    if (perPage) url.searchParams.set('per_page', String(perPage))
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url.toString(), controller.signal)
        if (!res.ok) return undefined
        const data = await res.json()
        return data as GithubReleaseItem[]
    } finally {
        sub.dispose()
    }
}

export class GithubListReleasesTool implements LanguageModelTool<GithubListReleasesInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubListReleasesInput>,
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
            const perPage = normalizePerPage(options.input?.per_page)
            const items = await listReleases(owner, repo, perPage, token)
            if (!items) {
                throw new Error('Failed to retrieve releases data from GitHub')
            }
            const body = formatResults(owner, repo, items)
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createGithubContentSession(uid, 'github_list_releases')
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
                new vscode.LanguageModelTextPart(`github_list_releases error: ${message}`),
            ])
        } finally {
            statusBarActivity.end('github')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GithubListReleasesInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('github')
        const owner = options.input?.owner ?? '<missing-owner>'
        const repo = options.input?.repo ?? '<missing-repo>'
        const perPage = options.input?.per_page
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **github_list_releases**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Repo: \`${owner}/${repo}\`  \n`)
        if (typeof perPage === 'number') md.appendMarkdown(`• Per Page: \`${perPage}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
