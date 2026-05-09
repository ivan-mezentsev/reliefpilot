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

export interface GithubListPullRequestsInput {
    owner: string
    repo: string
    state?: string
    head?: string
    base?: string
    sort?: string
    direction?: string
    per_page?: number
    page?: number
}

interface GithubPullRequestListItem {
    number: number
    title: string
    state: string
    draft?: boolean
    html_url: string
    created_at: string
    updated_at: string
    merged_at?: string | null
    user?: { login?: string }
    head?: { ref?: string }
    base?: { ref?: string }
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

function normalizePage(raw?: number): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
    return Math.trunc(raw)
}

function formatPullRequest(pr: GithubPullRequestListItem): string {
    const lines: string[] = []
    lines.push(`- Number: #${pr.number}`)
    lines.push(`- Title: ${pr.title}`)
    lines.push(`- State: ${pr.state}${pr.draft ? ' (draft)' : ''}`)
    if (pr.user?.login) lines.push(`- Author: ${pr.user.login}`)
    if (pr.base?.ref) lines.push(`- Base: ${pr.base.ref}`)
    if (pr.head?.ref) lines.push(`- Head: ${pr.head.ref}`)
    lines.push(`- Updated: ${pr.updated_at}`)
    if (pr.merged_at) lines.push(`- Merged At: ${pr.merged_at}`)
    lines.push(`- URL: ${pr.html_url}`)
    return lines.join('\n')
}

function formatResults(owner: string, repo: string, items: GithubPullRequestListItem[]): string {
    if (!items || items.length === 0) {
        return `No pull requests found for ${owner}/${repo}.`
    }
    const header = `GitHub Pull Requests for ${owner}/${repo} (showing ${items.length})`
    return `${header}\n\n` + items.map(formatPullRequest).join('\n----------\n')
}

async function listPullRequests(
    owner: string,
    repo: string,
    filters: Omit<GithubListPullRequestsInput, 'owner' | 'repo'>,
    token: CancellationToken,
): Promise<GithubPullRequestListItem[] | undefined> {
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`
    const url = new URL(base)
    if (filters.state) url.searchParams.set('state', filters.state)
    if (filters.head) url.searchParams.set('head', filters.head)
    if (filters.base) url.searchParams.set('base', filters.base)
    if (filters.sort) url.searchParams.set('sort', filters.sort)
    if (filters.direction) url.searchParams.set('direction', filters.direction)
    if (filters.per_page) url.searchParams.set('per_page', String(filters.per_page))
    if (filters.page) url.searchParams.set('page', String(filters.page))
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url.toString(), controller.signal)
        if (!res.ok) return undefined
        const data = await res.json()
        return data as GithubPullRequestListItem[]
    } finally {
        sub.dispose()
    }
}

export class GithubListPullRequestsTool implements LanguageModelTool<GithubListPullRequestsInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubListPullRequestsInput>,
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
            const page = normalizePage(options.input?.page)
            const items = await listPullRequests(owner, repo, {
                state: options.input?.state,
                head: options.input?.head,
                base: options.input?.base,
                sort: options.input?.sort,
                direction: options.input?.direction,
                per_page: perPage,
                page,
            }, token)
            if (!items) {
                throw new Error('Failed to retrieve pull requests data from GitHub')
            }
            const body = formatResults(owner, repo, items)
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createGithubContentSession(uid, 'github_list_pull_requests')
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
                new vscode.LanguageModelTextPart(`github_list_pull_requests error: ${message}`),
            ])
        } finally {
            statusBarActivity.end('github')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GithubListPullRequestsInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('github')
        const owner = options.input?.owner ?? '<missing-owner>'
        const repo = options.input?.repo ?? '<missing-repo>'
        const perPage = options.input?.per_page
        const page = options.input?.page
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **github_list_pull_requests**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Repo: \`${owner}/${repo}\`  \n`)
        if (typeof perPage === 'number') md.appendMarkdown(`• Per Page: \`${perPage}\`  \n`)
        if (typeof page === 'number') md.appendMarkdown(`• Page: \`${page}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
