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
import { getExaApiKey } from '../utils/exa_search_auth'
import { createExaContentSession, finalizeExaSession } from '../utils/exa_search_content_sessions'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { statusBarActivity } from '../utils/statusBar'
import { validateExaTokenFromResponse } from '../utils/validate_exa_token'

export interface ExaDateRangeInput {
    fromDate?: string
    toDate?: string
}

export interface ExaSearchInput {
    query: string
    maxResults?: number
    publishedDateRange?: ExaDateRangeInput
    crawlDateRange?: ExaDateRangeInput
    userLocation?: string
    includeText?: string
    excludeText?: string
    domain?: string
}

interface ExaSearchResultItem {
    title?: string
    url?: string
    score?: number
    publishedDate?: string
    author?: string
}

interface ExaApiResponse {
    requestId?: string
    results?: ExaSearchResultItem[]
    searchType?: string
    costDollars?: unknown
    error?: {
        message?: string
        code?: string
    }
}

interface ExaSearchError {
    error: {
        code?: number
        message?: string
        details?: unknown
    }
}

function normalizeQuery(raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error('Missing required parameter: query')
    }
    return raw.trim()
}

function normalizePositiveInt(raw: unknown, def: number, min: number, max: number): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return def
    const v = Math.trunc(raw)
    if (v < min) return min
    if (v > max) return max
    return v
}

function normalizeMaxResults(raw?: number): number {
    // Per requirements: default 10, min 1, max 25 (server clamps further).
    return normalizePositiveInt(raw, 10, 1, 25)
}

function normalizeUserLocation(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    const v = raw.trim()
    if (!v) return undefined
    if (!/^[A-Za-z]{2}$/.test(v)) {
        throw new Error(`Invalid userLocation: ${v}. Expected 2-letter ISO country code (e.g., US)`)
    }
    return v.toUpperCase()
}

function toIsoOrThrow(raw: string): string {
    const ms = Date.parse(raw)
    if (!Number.isFinite(ms)) {
        throw new Error(`Invalid date-time: ${raw}. Expected RFC3339/ISO 8601 or YYYY-MM-DD`)
    }
    return new Date(ms).toISOString()
}

function normalizeDateTime(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    const v = raw.trim()
    if (!v) return undefined
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        // Per requirements: convert YYYY-MM-DD to YYYY-MM-DDT00:00:00.000Z
        return `${v}T00:00:00.000Z`
    }
    return toIsoOrThrow(v)
}

function normalizePhrase5Words(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    const v = raw.trim()
    if (!v) return undefined
    const words = v.split(/\s+/g).filter(Boolean)
    if (words.length > 5) {
        throw new Error(`Phrase must be up to 5 words: ${v}`)
    }
    return v
}

function normalizeDomain(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    const v = raw.trim()
    if (!v) return undefined

    // Accept either a domain or a URL and normalize to hostname.
    try {
        if (/^https?:\/\//i.test(v)) {
            const u = new URL(v)
            return u.hostname
        }
    } catch { /* noop */ }

    // If it looks like a URL path without scheme, try parsing as https.
    if (v.includes('/')) {
        try {
            const u = new URL(`https://${v}`)
            return u.hostname
        } catch { /* noop */ }
    }

    // Fallback: treat as domain, strip protocol-like prefix and trailing slash.
    return v.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

function escapeMd(raw: string): string {
    return raw.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&')
}

function formatDateForDisplay(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    const v = raw.trim()
    if (!v) return undefined
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
    // Common Exa shape is RFC3339/ISO date-time. Display as YYYY-MM-DD.
    const ms = Date.parse(v)
    if (!Number.isFinite(ms)) return v
    return new Date(ms).toISOString().slice(0, 10)
}

function mapApiError(status: number, rawText: string): ExaSearchError {
    try {
        const parsed = JSON.parse(rawText) as ExaApiResponse
        return {
            error: {
                code: status,
                message: parsed.error?.message || rawText,
                details: parsed.error,
            },
        }
    } catch {
        return { error: { code: status, message: rawText } }
    }
}

function formatResultsMarkdown(params: {
    query: string
    maxResults: number
    domain?: string
    userLocation?: string
    includeText?: string
    excludeText?: string
    publishedFrom?: string
    publishedTo?: string
    crawlFrom?: string
    crawlTo?: string
    response: ExaApiResponse
}): string {
    const {
        query,
        maxResults,
        domain,
        userLocation,
        includeText,
        excludeText,
        publishedFrom,
        publishedTo,
        crawlFrom,
        crawlTo,
        response,
    } = params

    const lines: string[] = []
    lines.push(`### Exa search results for "${escapeMd(query)}"`)
    lines.push('')
    lines.push(`- Max results: \`${maxResults}\``)
    if (domain) lines.push(`- Domain: \`${escapeMd(domain)}\``)
    if (userLocation) lines.push(`- User location: \`${escapeMd(userLocation)}\``)
    if (includeText) lines.push(`- Include text: \`${escapeMd(includeText)}\``)
    if (excludeText) lines.push(`- Exclude text: \`${escapeMd(excludeText)}\``)
    if (publishedFrom || publishedTo) {
        const pf = formatDateForDisplay(publishedFrom) ?? publishedFrom
        const pt = formatDateForDisplay(publishedTo) ?? publishedTo
        lines.push(`- Published date range: from \`${escapeMd(pf ?? '-') }\` to \`${escapeMd(pt ?? '-') }\``)
    }
    if (crawlFrom || crawlTo) {
        const cf = formatDateForDisplay(crawlFrom) ?? crawlFrom
        const ct = formatDateForDisplay(crawlTo) ?? crawlTo
        lines.push(`- Crawl date range: from \`${escapeMd(cf ?? '-') }\` to \`${escapeMd(ct ?? '-') }\``)
    }
    if (response.requestId) lines.push(`- Request id: \`${escapeMd(response.requestId)}\``)
    lines.push('')

    const items = response.results ?? []
    if (items.length === 0) {
        lines.push('No results found.')
        return lines.join('\n')
    }

    items.forEach((item, idx) => {
        const title = item.title?.trim() || `Result ${idx + 1}`
        const url = item.url?.trim() || '#'
        lines.push(`${idx + 1}. [${escapeMd(title)}](${url})`)
        const meta: string[] = []
        if (typeof item.score === 'number' && Number.isFinite(item.score)) meta.push(`score: ${item.score.toFixed(4)}`)
        if (item.publishedDate) meta.push(`published: ${formatDateForDisplay(item.publishedDate) ?? item.publishedDate}`)
        if (item.author) meta.push(`author: ${item.author}`)
        if (meta.length > 0) {
            lines.push(`   ${escapeMd(meta.join(' · '))}`)
        }
        lines.push('')
    })

    return lines.join('\n')
}

async function performExaSearch(input: ExaSearchInput, token: CancellationToken): Promise<ExaApiResponse | ExaSearchError> {
    const query = normalizeQuery(input.query)
    const maxResults = normalizeMaxResults(input.maxResults)
    const domain = normalizeDomain(input.domain)
    const userLocation = normalizeUserLocation(input.userLocation)
    const includeText = normalizePhrase5Words(input.includeText)
    const excludeText = normalizePhrase5Words(input.excludeText)
    const publishedFrom = normalizeDateTime(input.publishedDateRange?.fromDate)
    const publishedTo = normalizeDateTime(input.publishedDateRange?.toDate)
    const crawlFrom = normalizeDateTime(input.crawlDateRange?.fromDate)
    const crawlTo = normalizeDateTime(input.crawlDateRange?.toDate)

    let apiKey = await getExaApiKey()

    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())

    try {
        while (true) {
            apiKey = await getExaApiKey() || ''
            const payload: Record<string, unknown> = {
                query,
                type: 'auto',
                numResults: maxResults,
            }

            if (userLocation) payload.userLocation = userLocation
            if (domain) payload.includeDomains = [domain]
            if (publishedFrom) payload.startPublishedDate = publishedFrom
            if (publishedTo) payload.endPublishedDate = publishedTo
            if (crawlFrom) payload.startCrawlDate = crawlFrom
            if (crawlTo) payload.endCrawlDate = crawlTo
            if (includeText) payload.includeText = [includeText]
            if (excludeText) payload.excludeText = [excludeText]

            const res = await fetch('https://api.exa.ai/search', {
                signal: controller.signal,
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'User-Agent': 'reliefpilot-extension',
                },
                body: JSON.stringify(payload),
            })

            const text = await res.text().catch(() => '')

            if (res.ok) {
                try {
                    return JSON.parse(text) as ExaApiResponse
                } catch {
                    return { error: { code: 500, message: 'Failed to parse Exa response' } }
                }
            }

            let isInvalidApiKeyTag = false
            try {
                const parsed = JSON.parse(text)
                isInvalidApiKeyTag = typeof parsed?.tag === 'string' && parsed.tag.toUpperCase() === 'INVALID_API_KEY'
            } catch {
                isInvalidApiKeyTag = false
            }

            if (res.status === 400 || res.status === 401 || isInvalidApiKeyTag) {
                const shouldRetry = await validateExaTokenFromResponse(res.status, text)
                if (shouldRetry) {
                    continue
                }
            }

            return mapApiError(res.status, text)
        }
    } finally {
        sub.dispose()
    }
}

export class ExaSearchTool implements LanguageModelTool<ExaSearchInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<ExaSearchInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
        const session = createExaContentSession(uid, 'exa_search')

        try {
            let haltState = haltForFeedbackController.getSnapshot()
            if (haltState.kind === 'paused') {
                haltState = await haltForFeedbackController.waitUntilNotPaused(token)
            }

            if (token.isCancellationRequested) {
                throw new Error('Cancelled')
            }

            if (haltState.kind === 'declined') {
                haltForFeedbackController.takeDeclineAndReset()
                throw new Error('Tool execution was declined by the user. Feedback: ' + haltState.feedback)
            }

            const input = options.input ?? ({} as ExaSearchInput)
            const query = normalizeQuery(input.query)
            const maxResults = normalizeMaxResults(input.maxResults)
            const domain = normalizeDomain(input.domain)
            const userLocation = normalizeUserLocation(input.userLocation)
            const includeText = normalizePhrase5Words(input.includeText)
            const excludeText = normalizePhrase5Words(input.excludeText)
            const publishedFrom = normalizeDateTime(input.publishedDateRange?.fromDate)
            const publishedTo = normalizeDateTime(input.publishedDateRange?.toDate)
            const crawlFrom = normalizeDateTime(input.crawlDateRange?.fromDate)
            const crawlTo = normalizeDateTime(input.crawlDateRange?.toDate)

            const response = await performExaSearch(input, token)
            if ((response as ExaSearchError).error) {
                const original = JSON.stringify(response, null, 2)
                const body = `exa_search error (original response):\n${original}`
                session.contentBuffer = body
                try { session.contentEmitter.fire(session.contentBuffer) } catch { }
                throw new Error(original)
            }

            const body = formatResultsMarkdown({
                query,
                maxResults,
                domain,
                userLocation,
                includeText,
                excludeText,
                publishedFrom,
                publishedTo,
                crawlFrom,
                crawlTo,
                response: response as ExaApiResponse,
            })

            session.contentBuffer = body
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const errorBody = `exa_search error: ${message}`
            session.contentBuffer = errorBody
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }

            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                throw new Error(message)
            }

            throw err instanceof Error ? err : new Error(message)
        } finally {
            finalizeExaSession(uid)
            statusBarActivity.end('exa_search')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<ExaSearchInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('exa_search')

        const input = options.input ?? ({} as ExaSearchInput)
        const query = input.query ?? '<missing-query>'
        const maxResults = input.maxResults
        const domain = input.domain
        const userLocation = input.userLocation
        const includeText = input.includeText
        const excludeText = input.excludeText
        const publishedFrom = input.publishedDateRange?.fromDate
        const publishedTo = input.publishedDateRange?.toDate
        const crawlFrom = input.crawlDateRange?.fromDate
        const crawlTo = input.crawlDateRange?.toDate

        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true

        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)

        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **exa_search**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Query: \`${query}\`  \n`)
        if (typeof maxResults === 'number') {
            md.appendMarkdown(`• Max results: \`${maxResults}\`  \n`)
        }
        if (domain) {
            md.appendMarkdown(`• Domain: \`${domain}\`  \n`)
        }
        if (userLocation) {
            md.appendMarkdown(`• User location: \`${userLocation}\`  \n`)
        }
        if (includeText) {
            md.appendMarkdown(`• Include text: \`${includeText}\`  \n`)
        }
        if (excludeText) {
            md.appendMarkdown(`• Exclude text: \`${excludeText}\`  \n`)
        }
        if (publishedFrom || publishedTo) {
            md.appendMarkdown(`• Published date range: from \`${publishedFrom ?? '-'}\` to \`${publishedTo ?? '-'}\`  \n`)
        }
        if (crawlFrom || crawlTo) {
            md.appendMarkdown(`• Crawl date range: from \`${crawlFrom ?? '-'}\` to \`${crawlTo ?? '-'}\`  \n`)
        }

        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.exa.showContent?${cmdArgs})`)

        return { invocationMessage: md }
    }
}
