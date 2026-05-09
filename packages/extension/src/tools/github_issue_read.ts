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

export interface GithubIssueReadInput {
    owner: string
    repo: string
    issue_number: number
}

// GitHub REST API shapes (subset aligned with example payload; extra fields are optional)
interface GithubUser {
    login: string
    id: number
    node_id: string
    avatar_url: string
    html_url: string
    gravatar_id?: string
    type: string
    site_admin: boolean
    url: string
    events_url: string
    following_url: string
    followers_url: string
    gists_url: string
    organizations_url: string
    received_events_url: string
    repos_url: string
    starred_url: string
    subscriptions_url: string
}

interface GithubLabel {
    id?: number
    node_id?: string
    url?: string
    name: string
    description?: string | null
    color?: string
    default?: boolean
}

interface GithubMilestone {
    url: string
    html_url: string
    labels_url: string
    id: number
    number: number
    state: string
    title: string
    description: string | null
    creator: GithubUser
    open_issues: number
    closed_issues: number
    created_at: string
    updated_at: string
    closed_at: string | null
    due_on: string | null
    node_id: string
}

interface GithubReactions {
    total_count: number
    ['+1']: number
    ['-1']: number
    laugh: number
    confused: number
    heart: number
    hooray: number
    rocket: number
    eyes: number
    url: string
}

interface GithubIssue {
    id: number
    number: number
    title: string
    state: string
    state_reason?: string | null
    locked?: boolean
    author_association?: string
    html_url: string
    url: string
    comments_url: string
    events_url: string
    labels_url: string
    repository_url?: string
    node_id: string
    user?: GithubUser
    body?: string | null
    closed_at?: string | null
    created_at: string
    updated_at: string
    closed_by?: GithubUser
    comments: number
    labels?: (GithubLabel | string)[]
    milestone?: GithubMilestone | null
    reactions?: GithubReactions
}

function normalizeString(name: string, raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error(`Missing required parameter: ${name}`)
    }
    return raw.trim()
}

function normalizeIssueNumber(raw?: number): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
        throw new Error('Missing or invalid required parameter: issue_number')
    }
    return Math.trunc(raw)
}

async function getIssue(owner: string, repo: string, issueNumber: number, token: CancellationToken): Promise<GithubIssue | undefined> {
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(base, controller.signal)
        if (!res.ok) return undefined
        const data = await res.json()
        return data as GithubIssue
    } finally {
        sub.dispose()
    }
}

// Render full issue content as Markdown without truncation.
function formatSingleIssueFull(i: GithubIssue): string {
    const lines: string[] = []
    lines.push(`- id: ${i.id}`)
    lines.push(`- number: ${i.number}`)
    lines.push(`- title: ${i.title}`)
    lines.push(`- state: ${i.state}`)
    if (i.state_reason) lines.push(`- state_reason: ${i.state_reason}`)
    if (typeof i.locked === 'boolean') lines.push(`- locked: ${i.locked}`)
    if (i.author_association) lines.push(`- author_association: ${i.author_association}`)
    lines.push(`- html_url: ${i.html_url}`)
    lines.push(`- url: ${i.url}`)
    lines.push(`- comments_url: ${i.comments_url}`)
    lines.push(`- events_url: ${i.events_url}`)
    lines.push(`- labels_url: ${i.labels_url}`)
    if (i.repository_url) lines.push(`- repository_url: ${i.repository_url}`)
    lines.push(`- node_id: ${i.node_id}`)
    lines.push(`- comments: ${i.comments}`)
    lines.push(`- created_at: ${i.created_at}`)
    lines.push(`- updated_at: ${i.updated_at}`)
    if (i.closed_at) lines.push(`- closed_at: ${i.closed_at}`)
    if (i.user) {
        lines.push(`- user.login: ${i.user.login}`)
        lines.push(`- user.id: ${i.user.id}`)
        lines.push(`- user.node_id: ${i.user.node_id}`)
        lines.push(`- user.type: ${i.user.type}`)
        lines.push(`- user.site_admin: ${i.user.site_admin}`)
    }
    if (i.closed_by) {
        lines.push(`- closed_by.login: ${i.closed_by.login}`)
        lines.push(`- closed_by.id: ${i.closed_by.id}`)
        lines.push(`- closed_by.node_id: ${i.closed_by.node_id}`)
    }
    if (i.milestone) {
        lines.push(`- milestone.title: ${i.milestone.title}`)
        lines.push(`- milestone.state: ${i.milestone.state}`)
        lines.push(`- milestone.number: ${i.milestone.number}`)
        lines.push(`- milestone.open_issues: ${i.milestone.open_issues}`)
        lines.push(`- milestone.closed_issues: ${i.milestone.closed_issues}`)
        if (i.milestone.due_on) lines.push(`- milestone.due_on: ${i.milestone.due_on}`)
    }
    if (i.labels && i.labels.length > 0) {
        const names = i.labels.map(l => typeof l === 'string' ? l : (l.name ?? '')).filter(Boolean)
        if (names.length > 0) lines.push(`- labels: ${names.join(', ')}`)
    }
    if (i.reactions) {
        const r = i.reactions
        lines.push(`- reactions.total_count: ${r.total_count}`)
        lines.push(`- reactions.+1: ${r['+1']}`)
        lines.push(`- reactions.-1: ${r['-1']}`)
        lines.push(`- reactions.laugh: ${r.laugh}`)
        lines.push(`- reactions.confused: ${r.confused}`)
        lines.push(`- reactions.heart: ${r.heart}`)
        lines.push(`- reactions.hooray: ${r.hooray}`)
        lines.push(`- reactions.rocket: ${r.rocket}`)
        lines.push(`- reactions.eyes: ${r.eyes}`)
    }
    if (i.body && i.body.trim().length > 0) {
        lines.push('\nBody:\n')
        lines.push(i.body)
    } else {
        lines.push('\nBody:\n')
        lines.push('(empty)')
    }
    return lines.join('\n')
}

function toMarkdown(owner: string, repo: string, issue: GithubIssue): string {
    const header = `GitHub Issue (full) ${owner}/${repo} #${issue.number}`
    return `${header}\n\n${formatSingleIssueFull(issue)}`
}

export class GithubIssueReadTool implements LanguageModelTool<GithubIssueReadInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubIssueReadInput>,
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
            const issueNumber = normalizeIssueNumber(options.input?.issue_number)
            const issue = await getIssue(owner, repo, issueNumber, token)
            if (!issue) {
                throw new Error('Failed to retrieve issue from GitHub')
            }
            const body = toMarkdown(owner, repo, issue)
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createGithubContentSession(uid, 'github_issue_read')
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
                new vscode.LanguageModelTextPart(`github_issue_read error: ${message}`),
            ])
        } finally {
            statusBarActivity.end('github')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GithubIssueReadInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('github')
        const owner = options.input?.owner ?? '<missing-owner>'
        const repo = options.input?.repo ?? '<missing-repo>'
        const issueNumber = options.input?.issue_number
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **github_issue_read**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Repo: \`${owner}/${repo}\`  \n`)
        if (typeof issueNumber === 'number') md.appendMarkdown(`• Issue: \`#${issueNumber}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
