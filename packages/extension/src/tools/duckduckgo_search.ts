import { randomUUID } from 'node:crypto'
import type {
    CancellationToken,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    PreparedToolInvocation,
} from 'vscode'
import * as vscode from 'vscode'
import { createDuckDuckGoContentSession, finalizeDuckDuckGoSession } from '../utils/duckduckgo_search_content_sessions'
import { env } from '../utils/env'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { statusBarActivity } from '../utils/statusBar'

export interface DuckDuckGoSearchInput {
    query: string
    page?: number
    numResults?: number
}

interface DuckDuckGoResultItem {
    title: string
    url: string
    snippet: string
    display_url?: string
    favicon?: string
}

// Global, lightweight FIFO rate limiter for DuckDuckGo requests
// Ensures serialized requests with a minimal delay between starts.
// Keeps visualization/session behavior unchanged; only affects when the network call starts.
type TaskFn<T> = () => Promise<T>
interface QueueItem<T> { run: TaskFn<T>; resolve: (v: T) => void; reject: (e: unknown) => void; token: CancellationToken; position: number }

const DUCKDUCKGO_BASE_INTERVAL_MS = 5000 // 5s base, escalates with queue position similar to reference implementation
let duckduckgoLastRunAt = 0
const duckduckgoQueue: QueueItem<any>[] = []
let duckduckgoRunning = false
let duckduckgoWaitingCount = 0

function computeRequiredIntervalMs(position: number): number {
    // 1..=3 => 5s, 4 =>10s, 5 =>15s, 6 =>20s, etc.
    if (position <= 3) return DUCKDUCKGO_BASE_INTERVAL_MS
    return DUCKDUCKGO_BASE_INTERVAL_MS * (position - 2)
}

function scheduleWithGlobalRateLimit<T>(run: TaskFn<T>, token: CancellationToken): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const position = ++duckduckgoWaitingCount
        duckduckgoQueue.push({ run, resolve, reject, token, position })
        pumpDuckDuckGoQueue()
    })
}

function cancellableDelay(ms: number, token: CancellationToken): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            sub.dispose()
            resolve()
        }, ms)
        const sub = token.onCancellationRequested(() => {
            clearTimeout(timer)
            sub.dispose()
            reject(new Error('Cancelled'))
        })
    })
}

async function pumpDuckDuckGoQueue(): Promise<void> {
    if (duckduckgoRunning) return
    duckduckgoRunning = true
    try {
        while (duckduckgoQueue.length > 0) {
            const item = duckduckgoQueue.shift()!
            if (item.token.isCancellationRequested) {
                item.reject(new Error('Cancelled'))
                continue
            }

            // Compute dynamic minimal interval based on the captured queue position
            const now = Date.now()
            let waitMs = 0
            if (duckduckgoLastRunAt > 0) {
                const required = computeRequiredIntervalMs(item.position)
                const elapsed = now - duckduckgoLastRunAt
                waitMs = Math.max(0, required - elapsed)
            }
            try { await cancellableDelay(waitMs, item.token) } catch (e) { item.reject(e); continue }

            if (item.token.isCancellationRequested) { item.reject(new Error('Cancelled')); continue }
            duckduckgoLastRunAt = Date.now()
            // This task has passed the rate limiter gate; update waiting count
            if (duckduckgoWaitingCount > 0) duckduckgoWaitingCount--
            try {
                const result = await item.run()
                item.resolve(result)
            } catch (err) {
                item.reject(err)
            }
        }
    } finally {
        duckduckgoRunning = false
        // In case new items were enqueued during the final await
        if (duckduckgoQueue.length > 0 && !duckduckgoRunning) pumpDuckDuckGoQueue()
    }
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
]

function pickUserAgent(): string { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] }

function normalizeQuery(raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) throw new Error('Missing required parameter: query')
    return raw.trim()
}
function normalizePage(raw?: number): number { if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1; const v = Math.trunc(raw); return v < 1 ? 1 : v }
function normalizeNumResults(raw?: number): number { if (raw === undefined || raw === null || typeof raw !== 'number' || !Number.isFinite(raw)) return 10; const v = Math.trunc(raw); if (v < 1) return 1; if (v > 20) throw new Error('numResults cannot exceed 20'); return v }
function buildDuckDuckGoUrl(query: string, startIndex: number): string { return `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&s=${startIndex}` }

function extractDirectUrl(raw: string): string {
    let urlStr = raw
    if (raw.startsWith('//')) urlStr = `https:${raw}`
    else if (raw.startsWith('/')) urlStr = `https://duckduckgo.com${raw}`
    try {
        const u = new URL(urlStr)
        if (u.host === 'duckduckgo.com' && u.pathname === '/l/') { const uddg = u.searchParams.get('uddg'); if (uddg) { try { return decodeURIComponent(uddg) } catch { return uddg } } }
        if (u.host === 'duckduckgo.com' && u.pathname === '/y.js') { const u3 = u.searchParams.get('u3'); if (u3) { try { const u3d = decodeURIComponent(u3); const nested = new URL(u3d); const click = nested.searchParams.get('ld'); if (click) { try { return decodeURIComponent(click) } catch { return click } } return u3d } catch { } } }
        return urlStr
    } catch { return urlStr }
}
function faviconFor(url: string): string | undefined { try { const u = new URL(url); return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32` } catch { return undefined } }
function cleanText(html: string): string { const noTags = html.replace(/<[^>]+>/g, ' '); const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }; const decoded = noTags.replace(/&(amp|lt|gt|quot|#39);/g, m => entities[m] || m); return decoded.replace(/\s+/g, ' ').trim() }

async function performDuckDuckGoSearch(input: DuckDuckGoSearchInput, token: CancellationToken): Promise<DuckDuckGoResultItem[]> {
    const query = normalizeQuery(input.query)
    const page = normalizePage(input.page)
    const numResults = normalizeNumResults(input.numResults)
    const startIndex = (page - 1) * 10
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetch(buildDuckDuckGoUrl(query, startIndex), { signal: controller.signal, method: 'GET', headers: { 'User-Agent': pickUserAgent(), 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br' } })
        const html = await res.text().catch(() => '')
        if (!res.ok) throw new Error(`Failed to fetch search results: ${res.status}`)
        if (html.includes('captcha') || html.includes('blocked') || html.includes('anomaly-modal') || html.length < 1000) throw new Error('Request limit exceeded, try other tool for search')
        const anchorRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi
        const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/a>/gi
        const displayUrlRegex = /<(?:span|div)[^>]*class="[^"]*result__url[^"]*"[^>]*>(.*?)<\/[^>]+>/gi
        const snippets: string[] = []
        const displayUrls: string[] = []
        let m: RegExpExecArray | null
        while ((m = snippetRegex.exec(html))) snippets.push(cleanText(m[1]))
        while ((m = displayUrlRegex.exec(html))) displayUrls.push(cleanText(m[1]))
        const results: DuckDuckGoResultItem[] = []
        let idx = 0
        while ((m = anchorRegex.exec(html))) {
            const rawLink = m[1]; const title = cleanText(m[2]); if (!title || !rawLink) continue
            const direct = extractDirectUrl(rawLink)
            results.push({ title, url: direct, snippet: snippets[idx] || '', display_url: displayUrls[idx] || '', favicon: faviconFor(direct) })
            idx++
            if (results.length >= numResults) break
        }
        return results
    } finally { sub.dispose() }
}

function formatResults(query: string, page: number, items: DuckDuckGoResultItem[]): string {
    if (!items || items.length === 0) return 'No results found.'
    const lines: string[] = []
    lines.push(`Search results for "${query}":`)
    lines.push('')
    lines.push(`Page ${page}; showing ${items.length} result(s)`)
    lines.push('')
    items.forEach((r, i) => { lines.push(`${i + 1}. [${r.title}](${r.url})`); if (r.snippet) lines.push(`   ${r.snippet}`); if (r.display_url) lines.push(`   Source: ${r.display_url}`); lines.push('') })
    return lines.join('\n')
}

export class DuckDuckGoSearchTool implements LanguageModelTool<DuckDuckGoSearchInput> {
    private _pendingUids: string[] = []
    async invoke(options: LanguageModelToolInvocationOptions<DuckDuckGoSearchInput>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
        const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
        const session = createDuckDuckGoContentSession(uid, 'duckduckgo_search')
        try {
            // Halt for Feedback integration: gate before any long waits/network requests.
            let haltState = haltForFeedbackController.getSnapshot()
            if (haltState.kind === 'paused') {
                haltState = await haltForFeedbackController.waitUntilNotPaused(token)
            }

            // Respect VS Code cancellation while waiting in paused state.
            if (token.isCancellationRequested) {
                throw new Error('Cancelled')
            }

            if (haltState.kind === 'declined') {
                // Reset global state back to running and throw exact error message.
                haltForFeedbackController.takeDeclineAndReset()
                throw new Error('Tool execution was declined by the user. Feedback: ' + haltState.feedback)
            }

            const input = options.input ?? ({} as DuckDuckGoSearchInput)
            const query = normalizeQuery(input.query)
            const page = normalizePage(input.page)
            const numResults = normalizeNumResults(input.numResults)
            // Enforce global rate limit: serialize requests with minimal spacing between starts
            const items = await scheduleWithGlobalRateLimit(() => performDuckDuckGoSearch({ query, page, numResults }, token), token)
            const body = formatResults(query, page, items)
            session.contentBuffer = body
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const errorBody = `duckduckgo_search error: ${message}`
            session.contentBuffer = errorBody
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }

            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                // Preserve exact error format
                throw new Error(message)
            }

            throw err instanceof Error ? err : new Error(message)
        } finally {
            finalizeDuckDuckGoSession(uid)
            statusBarActivity.end('duckduckgo_search')
        }
    }
    prepareInvocation(options: LanguageModelToolInvocationPrepareOptions<DuckDuckGoSearchInput>): PreparedToolInvocation {
        statusBarActivity.start('duckduckgo_search')
        const input = options.input ?? ({} as DuckDuckGoSearchInput)
        const q = input.query ?? '<missing-query>'
        const page = input.page
        const numResults = input.numResults
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true; md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **duckduckgo_search**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Query: \`${q}\`  \n`)
        if (typeof page === 'number') md.appendMarkdown(`• Page: \`${page}\`  \n`)
        if (typeof numResults === 'number') md.appendMarkdown(`• Num Results: \`${numResults}\`  \n`)
        const uid = randomUUID(); this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.duckduckgo.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
