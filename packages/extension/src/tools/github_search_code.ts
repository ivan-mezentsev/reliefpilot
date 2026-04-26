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

export interface GithubSearchCodeInput {
    query: string
    per_page?: number
}

interface GithubSearchCodeItemRepository {
    full_name: string
}

interface GithubSearchCodeItem {
    name: string
    path: string
    sha: string
    html_url: string
    repository: GithubSearchCodeItemRepository
}

interface GithubSearchCodeResponse {
    total_count: number
    incomplete_results: boolean
    items: GithubSearchCodeItem[]
}

const GITHUB_RATE_LIMIT_COOLDOWN_BUFFER_MS = 5_000

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

function formatItem(i: GithubSearchCodeItem): string {
    const lines: string[] = []
    lines.push(`- Repo: ${i.repository.full_name}`)
    lines.push(`- File: ${i.path}`)
    lines.push(`- Name: ${i.name}`)
    lines.push(`- SHA: ${i.sha}`)
    lines.push(`- URL: ${i.html_url}`)
    return lines.join('\n')
}

function formatResults(resp: GithubSearchCodeResponse): string {
    if (!resp.items || resp.items.length === 0) {
        return 'No code results found for this query.'
    }
    const header = `GitHub Code Search Results (showing ${resp.items.length} of ${resp.total_count})`
    return `${header}\n\n` + resp.items.map(formatItem).join('\n----------\n')
}

function isRateLimitStatus(status: number): boolean {
    return status === 403 || status === 429
}

function isRateLimitError(res: Response, text: string): boolean {
    if (!isRateLimitStatus(res.status)) return false
    if (res.headers.get('retry-after')) return true
    if (res.headers.get('x-ratelimit-remaining') === '0') return true
    return text.toLowerCase().includes('rate limit')
}

function getRateLimitCooldownMs(res: Response): number | undefined {
    const retryAfter = res.headers.get('retry-after')
    if (retryAfter !== null) {
        const retryAfterSeconds = parseInt(retryAfter, 10)
        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
            return retryAfterSeconds * 1000 + GITHUB_RATE_LIMIT_COOLDOWN_BUFFER_MS
        }
    }

    if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = res.headers.get('x-ratelimit-reset')
        if (reset !== null) {
            const resetSeconds = Number(reset)
            if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
                return Math.max(0, resetSeconds * 1000 - Date.now()) + GITHUB_RATE_LIMIT_COOLDOWN_BUFFER_MS
            }
        }
    }

    return undefined
}

async function waitForCooldown(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return
    await new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => {
            if (timeout) clearTimeout(timeout)
            signal.removeEventListener('abort', onAbort)
        }
        const onAbort = () => {
            cleanup()
            reject(typeof DOMException !== 'undefined'
                ? new DOMException('This operation was aborted', 'AbortError')
                : new Error('This operation was aborted'))
        }
        timeout = setTimeout(() => {
            cleanup()
            resolve()
        }, ms)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
    })
}

async function searchCode(query: string, perPage: number | undefined, token: CancellationToken): Promise<GithubSearchCodeResponse | undefined> {
    const base = 'https://api.github.com/search/code'
    const url = new URL(base)
    // GitHub Search requires at least one non-qualifier keyword; we trust caller but we still encode.
    url.searchParams.set('q', query)
    if (perPage) url.searchParams.set('per_page', String(perPage))
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const requestCodeSearch = (returnRateLimitResponse: boolean) => fetchGitHub(
            url.toString(),
            controller.signal,
            undefined,
            returnRateLimitResponse ? { returnRateLimitResponse: true } : undefined,
        )
        let didRateLimitRetry = false
        const retryAfterRateLimitOnce = async (response: Response): Promise<Response> => {
            if (didRateLimitRetry) return response
            const errorText = await response.clone().text().catch(() => '')
            if (!isRateLimitError(response, errorText)) return response
            const cooldownMs = getRateLimitCooldownMs(response)
            if (cooldownMs === undefined) return response
            didRateLimitRetry = true
            await waitForCooldown(cooldownMs, controller.signal)
            return await requestCodeSearch(false)
        }

        const res = await retryAfterRateLimitOnce(await requestCodeSearch(true))
        if (!res.ok) {
            const txt = await res.text().catch(() => '')
            // Special handling: unauthenticated code search -> prompt for token then retry once
            let shouldRetryAuth = false
            if (res.status === 401) {
                try {
                    const body = txt ? JSON.parse(txt) : undefined
                    const msg = body?.message || ''
                    const errors = Array.isArray(body?.errors) ? body.errors : []
                    const hasMustAuth = msg.includes('Requires authentication') || errors.some((e: any) => typeof e?.message === 'string' && e.message.includes('Must be authenticated'))
                    if (hasMustAuth) shouldRetryAuth = true
                } catch { /* ignore JSON parse errors */ }
            }
            if (shouldRetryAuth) {
                // Ask user to input token; if cancelled, second fetch will still fail and we'll propagate
                try { await vscode.commands.executeCommand('reliefpilot.github.setupToken') } catch { /* ignore */ }
                const retry = await retryAfterRateLimitOnce(await requestCodeSearch(true))
                if (!retry.ok) {
                    const retryTxt = await retry.text().catch(() => '')
                    throw new Error(retryTxt || `${retry.status} ${retry.statusText}`)
                }
                const data = await retry.json()
                return data as GithubSearchCodeResponse
            }
            throw new Error(txt || `${res.status} ${res.statusText}`)
        }
        const data = await res.json()
        return data as GithubSearchCodeResponse
    } finally {
        sub.dispose()
    }
}

export class GithubSearchCodeTool implements LanguageModelTool<GithubSearchCodeInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GithubSearchCodeInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        // Always consume the pending UID early to keep link/session in sync, even on errors
        const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
        const session = createGithubContentSession(uid, 'github_search_code')
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
            let resp: GithubSearchCodeResponse | undefined
            try {
                resp = await searchCode(query, perPage, token)
            } catch (apiErr) {
                const apiMsg = apiErr instanceof Error ? apiErr.message : String(apiErr)
                throw new Error(`GitHub code search API error: ${apiMsg}`)
            }
            if (!resp) {
                throw new Error('Failed to retrieve code search data from GitHub')
            }
            const body = formatResults(resp)
            session.contentBuffer = body
            try { session.contentEmitter.fire(session.contentBuffer) } catch { /* ignore */ }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                // Preserve exact error format
                throw new Error(message)
            }
            // Also render the error into the session so the link works even on failure
            const errorBody = `github_search_code error: ${message}`
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
        options: LanguageModelToolInvocationPrepareOptions<GithubSearchCodeInput>,
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
        md.appendMarkdown(`Relief Pilot · **github_search_code**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}\n`)
        md.appendMarkdown(`- Query: \`${q}\`  \n`)
        if (typeof perPage === 'number') md.appendMarkdown(`- Per Page: \`${perPage}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.github.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
