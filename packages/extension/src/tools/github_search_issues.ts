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

export interface GithubSearchIssuesInput {
    query: string
    per_page?: number
}

interface GithubSearchIssuesItemLabel { name?: string }

interface GithubSearchIssuesItem {
    number: number
    title: string
    state: string
    html_url: string
    comments: number
    created_at: string
    updated_at: string
    user?: { login?: string }
    labels?: (GithubSearchIssuesItemLabel | string)[]
    repository_url?: string
    pull_request?: any // we skip PRs (presence of this key)
}

interface GithubSearchIssuesResponse {
    total_count: number
    incomplete_results: boolean
    items: GithubSearchIssuesItem[]
}

function normalizeQuery(raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error('Missing required parameter: query')
    }
    return raw.trim()
}

function normalizePerPage(raw?: number): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
    const v = Math.trunc(raw)
    return v > 100 ? 100 : v
}

function ensureIssueQualifier(q: string): string {
    return /\bis:issue\b/i.test(q) ? q : `is:issue ${q}`
}

function parseRepoFullName(repository_url?: string): string | undefined {
    if (!repository_url) return undefined
    const idx = repository_url.indexOf('/repos/')
    if (idx === -1) return undefined
    return repository_url.substring(idx + 7) // after '/repos/'
}

function formatIssue(i: GithubSearchIssuesItem): string {
    const lines: string[] = []
    const repoFull = parseRepoFullName(i.repository_url)
    if (repoFull) lines.push(`- Repo: ${repoFull}`)
    lines.push(`- Number: #${i.number}`)
    lines.push(`- Title: ${i.title}`)
    lines.push(`- State: ${i.state}`)
    if (i.user?.login) lines.push(`- Author: ${i.user.login}`)
    lines.push(`- Comments: ${i.comments}`)
    lines.push(`- Created: ${i.created_at}`)
    lines.push(`- Updated: ${i.updated_at}`)
    if (i.labels && i.labels.length > 0) {
        const names = i.labels.map(l => typeof l === 'string' ? l : (l.name ?? '')).filter(Boolean)
        if (names.length > 0) lines.push(`- Labels: ${names.join(', ')}`)
    }
    lines.push(`- URL: ${i.html_url}`)
    return lines.join('\n')
}

function formatResults(resp: GithubSearchIssuesResponse): string {
    const onlyIssues = resp.items ? resp.items.filter(i => !i.pull_request) : []
    if (onlyIssues.length === 0) {
        return 'No issues found for this query.'
    }
    const header = `GitHub Issue Search Results (showing ${onlyIssues.length} of ${resp.total_count})`
    return `${header}\n\n` + onlyIssues.map(formatIssue).join('\n----------\n')
}

async function searchIssues(query: string, perPage: number | undefined, token: CancellationToken): Promise<GithubSearchIssuesResponse | undefined> {
    const base = 'https://api.github.com/search/issues'
    const url = new URL(base)
    url.searchParams.set('q', query)
    if (perPage) url.searchParams.set('per_page', String(perPage))
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url.toString(), controller.signal)
        if (!res.ok) return undefined
        const data = await res.json()
        return data as GithubSearchIssuesResponse
    } finally {
        sub.dispose()
    }
}

export class GithubSearchIssuesTool implements LanguageModelTool<GithubSearchIssuesInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubSearchIssuesInput>,
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

            const queryRaw = normalizeQuery(options.input?.query)
            const query = ensureIssueQualifier(queryRaw)
            const perPage = normalizePerPage(options.input?.per_page)
            const resp = await searchIssues(query, perPage, token)
            if (!resp) {
                throw new Error('Failed to retrieve issue search data from GitHub')
            }
            const body = formatResults(resp)
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createGithubContentSession(uid, 'github_search_issues')
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
                new vscode.LanguageModelTextPart(`github_search_issues error: ${message}`),
            ])
        } finally {
            statusBarActivity.end('github')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GithubSearchIssuesInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('github')
        const q = options.input?.query ?? '<missing-query>'
        const perPage = options.input?.per_page
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **github_search_issues**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Query: \`${q}\`  \n`)
        if (typeof perPage === 'number') md.appendMarkdown(`• Per Page: \`${perPage}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
