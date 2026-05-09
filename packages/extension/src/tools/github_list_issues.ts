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

export interface GithubListIssuesInput {
    owner: string
    repo: string
    per_page?: number
}

interface GithubListIssueLabel { name?: string }

interface GithubListIssueItem {
    number: number
    title: string
    state: string
    html_url: string
    comments: number
    updated_at: string
    user?: { login?: string }
    labels?: (GithubListIssueLabel | string)[]
    pull_request?: any
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

function formatIssue(i: GithubListIssueItem): string {
    const lines: string[] = []
    lines.push(`- Number: #${i.number}`)
    lines.push(`- Title: ${i.title}`)
    lines.push(`- State: ${i.state}`)
    if (i.user?.login) lines.push(`- Author: ${i.user.login}`)
    lines.push(`- Comments: ${i.comments}`)
    lines.push(`- Updated: ${i.updated_at}`)
    if (i.labels && i.labels.length > 0) {
        const names = i.labels.map(l => typeof l === 'string' ? l : (l.name ?? '')).filter(Boolean)
        if (names.length > 0) lines.push(`- Labels: ${names.join(', ')}`)
    }
    lines.push(`- URL: ${i.html_url}`)
    return lines.join('\n')
}

function formatResults(owner: string, repo: string, items: GithubListIssueItem[]): string {
    const onlyIssues = items.filter(i => !i.pull_request)
    if (onlyIssues.length === 0) {
        return `No issues found for ${owner}/${repo}.`
    }
    const header = `GitHub Issues for ${owner}/${repo} (showing ${onlyIssues.length})`
    return `${header}\n\n` + onlyIssues.map(formatIssue).join('\n----------\n')
}

async function listIssues(owner: string, repo: string, perPage: number | undefined, token: CancellationToken): Promise<GithubListIssueItem[] | undefined> {
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`
    const url = new URL(base)
    if (perPage) url.searchParams.set('per_page', String(perPage))
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url.toString(), controller.signal)
        if (!res.ok) return undefined
        const data = await res.json()
        return data as GithubListIssueItem[]
    } finally {
        sub.dispose()
    }
}

export class GithubListIssuesTool implements LanguageModelTool<GithubListIssuesInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubListIssuesInput>,
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
            const items = await listIssues(owner, repo, perPage, token)
            if (!items) {
                throw new Error('Failed to retrieve issues data from GitHub')
            }
            const body = formatResults(owner, repo, items)
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createGithubContentSession(uid, 'github_list_issues')
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
                new vscode.LanguageModelTextPart(`github_list_issues error: ${message}`),
            ])
        } finally {
            statusBarActivity.end('github')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GithubListIssuesInput>,
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
        md.appendMarkdown(`Relief Pilot · **github_list_issues**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Repo: \`${owner}/${repo}\`  \n`)
        if (typeof perPage === 'number') md.appendMarkdown(`• Per Page: \`${perPage}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
