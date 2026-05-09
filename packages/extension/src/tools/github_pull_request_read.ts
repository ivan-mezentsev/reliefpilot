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

export interface GithubPullRequestReadInput {
    method: string
    owner: string
    repo: string
    pull_number: number
    per_page?: number
    page?: number
}

interface GithubPullRequestUser { login?: string }
interface GithubPullRequestBranch { ref?: string; sha?: string }
interface GithubPullRequest {
    number: number
    title: string
    state: string
    draft?: boolean
    html_url: string
    created_at: string
    updated_at: string
    merged_at?: string | null
    body?: string | null
    user?: GithubPullRequestUser
    head?: GithubPullRequestBranch
    base?: GithubPullRequestBranch
}

interface GithubCombinedStatusStatusItem {
    context?: string
    state?: string
    description?: string
    target_url?: string
    created_at?: string
    updated_at?: string
}
interface GithubCombinedStatus {
    state: string
    sha: string
    total_count: number
    statuses: GithubCombinedStatusStatusItem[]
}

interface GithubPullRequestFileItem {
    filename: string
    status: string
    additions: number
    deletions: number
    changes: number
    blob_url?: string
    raw_url?: string
    patch?: string
}

interface GithubPullRequestReviewCommentItem {
    id: number
    user?: { login?: string }
    path?: string
    diff_hunk?: string
    body?: string
    created_at?: string
    updated_at?: string
    commit_id?: string
    original_commit_id?: string
    html_url?: string
}

interface GithubPullRequestReviewItem {
    id: number
    user?: { login?: string }
    state?: string
    body?: string | null
    submitted_at?: string | null
    commit_id?: string
    html_url?: string
}

interface GithubIssueCommentItem {
    id: number
    user?: { login?: string }
    body?: string
    created_at?: string
    updated_at?: string
    html_url?: string
}

const METHODS = new Set([
    'get',
    'get_diff',
    'get_status',
    'get_files',
    'get_review_comments',
    'get_reviews',
    'get_comments',
])

function normalizeString(name: string, raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error(`Missing required parameter: ${name}`)
    }
    return raw.trim()
}

function normalizeMethod(raw?: string): string {
    const m = normalizeString('method', raw)
    if (!METHODS.has(m)) throw new Error(`Invalid method: ${m}`)
    return m
}

function normalizePullNumber(raw?: number): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
        throw new Error('Missing or invalid required parameter: pull_number')
    }
    return Math.trunc(raw)
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

async function fetchJson(url: string, token: CancellationToken, accept?: string): Promise<any | undefined> {
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url, controller.signal, accept)
        if (!res.ok) return undefined
        return await res.json()
    } finally {
        sub.dispose()
    }
}

async function fetchText(url: string, token: CancellationToken, accept?: string): Promise<string | undefined> {
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchGitHub(url, controller.signal, accept)
        if (!res.ok) return undefined
        return await res.text()
    } finally {
        sub.dispose()
    }
}

// Formatting helpers
function formatPullRequest(pr: GithubPullRequest): string {
    const lines: string[] = []
    lines.push(`- number: ${pr.number}`)
    lines.push(`- title: ${pr.title}`)
    lines.push(`- state: ${pr.state}${pr.draft ? ' (draft)' : ''}`)
    if (pr.user?.login) lines.push(`- user.login: ${pr.user.login}`)
    if (pr.base?.ref) lines.push(`- base.ref: ${pr.base.ref}`)
    if (pr.head?.ref) lines.push(`- head.ref: ${pr.head.ref}`)
    lines.push(`- created_at: ${pr.created_at}`)
    lines.push(`- updated_at: ${pr.updated_at}`)
    if (pr.merged_at) lines.push(`- merged_at: ${pr.merged_at}`)
    if (pr.body && pr.body.trim().length > 0) {
        lines.push('\nBody:\n')
        lines.push(pr.body)
    } else {
        lines.push('\nBody:\n')
        lines.push('(empty)')
    }
    return lines.join('\n')
}

function formatCombinedStatus(status: GithubCombinedStatus): string {
    const lines: string[] = []
    lines.push(`Combined Status for ${status.sha}`)
    lines.push(`State: ${status.state}`)
    lines.push(`Checks: ${status.total_count}`)
    if (status.statuses && status.statuses.length > 0) {
        lines.push('\nIndividual Statuses:')
        for (const s of status.statuses) {
            const parts: string[] = []
            if (s.context) parts.push(`context=${s.context}`)
            if (s.state) parts.push(`state=${s.state}`)
            if (s.description) parts.push(`desc=${s.description}`)
            if (s.target_url) parts.push(`url=${s.target_url}`)
            lines.push('- ' + parts.join(' | '))
        }
    }
    return lines.join('\n')
}

function formatFiles(files: GithubPullRequestFileItem[]): string {
    if (!files || files.length === 0) return 'No files.'
    return files.map(f => {
        const lines: string[] = []
        lines.push(`- filename: ${f.filename}`)
        lines.push(`  status: ${f.status}`)
        lines.push(`  additions: ${f.additions}`)
        lines.push(`  deletions: ${f.deletions}`)
        lines.push(`  changes: ${f.changes}`)
        if (f.patch) lines.push('  patch: |\n' + f.patch.split('\n').map(l => '    ' + l).join('\n'))
        if (f.blob_url) lines.push(`  blob_url: ${f.blob_url}`)
        if (f.raw_url) lines.push(`  raw_url: ${f.raw_url}`)
        return lines.join('\n')
    }).join('\n----------\n')
}

function excerpt(body?: string, max = 400): string {
    if (!body) return '(empty)'
    const trimmed = body.trim()
    if (trimmed.length <= max) return trimmed
    return trimmed.slice(0, max) + '…'
}

function formatReviewComments(comments: GithubPullRequestReviewCommentItem[]): string {
    if (!comments || comments.length === 0) return 'No review comments.'
    return comments.map(c => {
        const lines: string[] = []
        lines.push(`- id: ${c.id}`)
        if (c.user?.login) lines.push(`  user: ${c.user.login}`)
        if (c.path) lines.push(`  path: ${c.path}`)
        if (c.diff_hunk) lines.push('  diff_hunk: |\n' + c.diff_hunk.split('\n').map(l => '    ' + l).join('\n'))
        lines.push('  body: |\n' + excerpt(c.body).split('\n').map(l => '    ' + l).join('\n'))
        if (c.commit_id) lines.push(`  commit_id: ${c.commit_id}`)
        if (c.html_url) lines.push(`  url: ${c.html_url}`)
        return lines.join('\n')
    }).join('\n----------\n')
}

function formatReviews(reviews: GithubPullRequestReviewItem[]): string {
    if (!reviews || reviews.length === 0) return 'No reviews.'
    return reviews.map(r => {
        const lines: string[] = []
        lines.push(`- id: ${r.id}`)
        if (r.user?.login) lines.push(`  user: ${r.user.login}`)
        if (r.state) lines.push(`  state: ${r.state}`)
        if (r.submitted_at) lines.push(`  submitted_at: ${r.submitted_at}`)
        if (r.commit_id) lines.push(`  commit_id: ${r.commit_id}`)
        if (r.body) lines.push('  body: |\n' + excerpt(r.body).split('\n').map(l => '    ' + l).join('\n'))
        if (r.html_url) lines.push(`  url: ${r.html_url}`)
        return lines.join('\n')
    }).join('\n----------\n')
}

function formatIssueComments(comments: GithubIssueCommentItem[]): string {
    if (!comments || comments.length === 0) return 'No issue comments.'
    return comments.map(c => {
        const lines: string[] = []
        lines.push(`- id: ${c.id}`)
        if (c.user?.login) lines.push(`  user: ${c.user.login}`)
        lines.push('  body: |\n' + excerpt(c.body).split('\n').map(l => '    ' + l).join('\n'))
        if (c.created_at) lines.push(`  created_at: ${c.created_at}`)
        if (c.updated_at) lines.push(`  updated_at: ${c.updated_at}`)
        if (c.html_url) lines.push(`  url: ${c.html_url}`)
        return lines.join('\n')
    }).join('\n----------\n')
}

export class GithubPullRequestReadTool implements LanguageModelTool<GithubPullRequestReadInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubPullRequestReadInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        // Pre-create session so the link always resolves (even if long-running or error)
        const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
        const session = createGithubContentSession(uid, 'github_pull_request_read')
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

            const method = normalizeMethod(options.input?.method)
            const owner = normalizeString('owner', options.input?.owner)
            const repo = normalizeString('repo', options.input?.repo)
            const pullNumber = normalizePullNumber(options.input?.pull_number)
            const perPage = normalizePerPage(options.input?.per_page)
            const page = normalizePage(options.input?.page)

            const basePr = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`
            let body = ''

            if (method === 'get') {
                const pr = await fetchJson(basePr, token) as GithubPullRequest | undefined
                if (!pr) throw new Error('Failed to retrieve pull request data from GitHub')
                body = `GitHub Pull Request ${owner}/${repo} #${pr.number}\n\n${formatPullRequest(pr)}`
            } else if (method === 'get_diff') {
                const diff = await fetchText(basePr, token, 'application/vnd.github.v3.diff')
                if (!diff) throw new Error('Failed to retrieve pull request diff from GitHub')
                const header = `# Pull Request Diff ${owner}/${repo} #${pullNumber}`
                body = `${header}\n\n\n\u2063\n\n\n` + '```diff\n' + diff + '\n```'
            } else if (method === 'get_status') {
                const pr = await fetchJson(basePr, token) as GithubPullRequest | undefined
                if (!pr || !pr.head?.sha) throw new Error('Failed to retrieve pull request (head sha missing)')
                const statusUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${pr.head.sha}/status`
                const status = await fetchJson(statusUrl, token) as GithubCombinedStatus | undefined
                if (!status) throw new Error('Failed to retrieve combined status from GitHub')
                body = `GitHub Pull Request Status ${owner}/${repo} #${pullNumber}\n\n${formatCombinedStatus(status)}`
            } else if (method === 'get_files') {
                const filesUrl = new URL(basePr + '/files')
                if (perPage) filesUrl.searchParams.set('per_page', String(perPage))
                if (page) filesUrl.searchParams.set('page', String(page))
                const files = await fetchJson(filesUrl.toString(), token) as GithubPullRequestFileItem[] | undefined
                if (!files) throw new Error('Failed to retrieve pull request files from GitHub')
                body = `GitHub Pull Request Files ${owner}/${repo} #${pullNumber}\n\n${formatFiles(files)}`
            } else if (method === 'get_review_comments') {
                const commentsUrl = new URL(basePr + '/comments')
                if (perPage) commentsUrl.searchParams.set('per_page', String(perPage))
                if (page) commentsUrl.searchParams.set('page', String(page))
                const comments = await fetchJson(commentsUrl.toString(), token) as GithubPullRequestReviewCommentItem[] | undefined
                if (!comments) throw new Error('Failed to retrieve pull request review comments from GitHub')
                body = `GitHub Pull Request Review Comments ${owner}/${repo} #${pullNumber}\n\n${formatReviewComments(comments)}`
            } else if (method === 'get_reviews') {
                const reviewsUrl = new URL(basePr + '/reviews')
                if (perPage) reviewsUrl.searchParams.set('per_page', String(perPage))
                if (page) reviewsUrl.searchParams.set('page', String(page))
                const reviews = await fetchJson(reviewsUrl.toString(), token) as GithubPullRequestReviewItem[] | undefined
                if (!reviews) throw new Error('Failed to retrieve pull request reviews from GitHub')
                body = `GitHub Pull Request Reviews ${owner}/${repo} #${pullNumber}\n\n${formatReviews(reviews)}`
            } else if (method === 'get_comments') {
                const commentsUrl = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments`)
                if (perPage) commentsUrl.searchParams.set('per_page', String(perPage))
                if (page) commentsUrl.searchParams.set('page', String(page))
                const comments = await fetchJson(commentsUrl.toString(), token) as GithubIssueCommentItem[] | undefined
                if (!comments) throw new Error('Failed to retrieve pull request issue comments from GitHub')
                body = `GitHub Pull Request Issue Comments ${owner}/${repo} #${pullNumber}\n\n${formatIssueComments(comments)}`
            } else {
                throw new Error('Unsupported method')
            }

            session.contentBuffer = body
            try { session.contentEmitter.fire(session.contentBuffer) } catch { /* ignore */ }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                // Preserve exact error format
                throw new Error(message)
            }
            const errorBody = `github_pull_request_read error: ${message}`
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
        options: LanguageModelToolInvocationPrepareOptions<GithubPullRequestReadInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('github')
        const method = options.input?.method ?? '<missing-method>'
        const owner = options.input?.owner ?? '<missing-owner>'
        const repo = options.input?.repo ?? '<missing-repo>'
        const pullNumber = options.input?.pull_number
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **github_pull_request_read**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Method: \`${method}\`  \n`)
        md.appendMarkdown(`• Repo: \`${owner}/${repo}\`  \n`)
        if (typeof pullNumber === 'number') md.appendMarkdown(`• Pull: \`#${pullNumber}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
