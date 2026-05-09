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

export interface GithubSearchRepositoriesInput {
    query: string
    per_page?: number
}

interface GithubRepoItem {
    full_name: string
    description: string | null
    stargazers_count: number
    forks_count: number
    language: string | null
    html_url: string
}

interface GithubSearchResponse {
    total_count: number
    incomplete_results: boolean
    items: GithubRepoItem[]
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

function formatRepo(r: GithubRepoItem): string {
    const lines: string[] = []
    lines.push(`- Name: ${r.full_name}`)
    if (r.description) lines.push(`- Description: ${r.description}`)
    lines.push(`- Stars: ${r.stargazers_count}`)
    lines.push(`- Forks: ${r.forks_count}`)
    if (r.language) lines.push(`- Language: ${r.language}`)
    lines.push(`- URL: ${r.html_url}`)
    return lines.join('\n')
}

function formatResults(resp: GithubSearchResponse): string {
    if (!resp.items || resp.items.length === 0) {
        return 'No repositories found for this query.'
    }
    const header = `GitHub Repository Search Results (showing ${resp.items.length} of ${resp.total_count})`
    return `${header}\n\n` + resp.items.map(formatRepo).join('\n----------\n')
}

async function searchRepositories(query: string, perPage: number | undefined, token: CancellationToken): Promise<GithubSearchResponse | undefined> {
    const base = 'https://api.github.com/search/repositories'
    const url = new URL(base)
    url.searchParams.set('q', query)
    if (perPage) url.searchParams.set('per_page', String(perPage))
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url.toString(), controller.signal)
        if (!res.ok) return undefined
        const data = await res.json()
        return data as GithubSearchResponse
    } finally {
        sub.dispose()
    }
}

export class GithubSearchRepositoriesTool implements LanguageModelTool<GithubSearchRepositoriesInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubSearchRepositoriesInput>,
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

            const query = normalizeQuery(options.input?.query)
            const perPage = normalizePerPage(options.input?.per_page)
            const resp = await searchRepositories(query, perPage, token)
            if (!resp) {
                throw new Error('Failed to retrieve repository data from GitHub')
            }
            const body = formatResults(resp)
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createGithubContentSession(uid, 'github_search_repositories')
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
                new vscode.LanguageModelTextPart(`github_search_repositories error: ${message}`),
            ])
        } finally {
            statusBarActivity.end('github')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GithubSearchRepositoriesInput>,
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
        md.appendMarkdown(`Relief Pilot · **github_search_repositories**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Query: \`${q}\`  \n`)
        if (typeof perPage === 'number') md.appendMarkdown(`• Per Page: \`${perPage}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
