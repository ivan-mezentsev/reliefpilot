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
import { getLinkupApiKey } from '../utils/linkup_search_auth'
import { createLinkupContentSession, finalizeLinkupSession } from '../utils/linkup_search_content_sessions'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { statusBarActivity } from '../utils/statusBar'
import { validateLinkupTokenFromResponse } from '../utils/validate_linkup_token'

export interface LinkupDateFilterInput {
    fromDate?: string
    toDate?: string
}

export interface LinkupSearchInput {
    query: string
    onlySearchTheseDomains?: string[]
    dateFilter?: LinkupDateFilterInput
    maxResults?: number
    // Backward-compatible aliases if agent sends direct keys
    fromDate?: string
    toDate?: string
}

interface LinkupResultItem {
    type?: string
    name?: string
    url?: string
    content?: string
    snippet?: string
    favicon?: string
}

interface LinkupSourceItem {
    name?: string
    url?: string
    snippet?: string
}

interface LinkupApiResponse {
    results?: LinkupResultItem[]
    answer?: string
    sources?: LinkupSourceItem[]
    statusCode?: number
    error?: {
        code?: string
        message?: string
        details?: Array<{ field?: string; message?: string }>
    }
}

interface LinkupSearchError {
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
    return normalizePositiveInt(raw, 5, 1, Number.MAX_SAFE_INTEGER)
}

function normalizeDomains(raw?: string[]): string[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const normalized = raw
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => v.length > 0)
        .map((v) => v.replace(/^https?:\/\//i, '').replace(/\/$/, ''))

    if (normalized.length === 0) return undefined

    const deduped = Array.from(new Set(normalized))
    return deduped.slice(0, 50)
}

function normalizeDate(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    const v = raw.trim()
    if (!v) return undefined
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error(`Invalid date format: ${v}. Expected YYYY-MM-DD`)
    }
    return v
}

function escapeMd(raw: string): string {
    return raw.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&')
}

function mapApiError(status: number, rawText: string): LinkupSearchError {
    try {
        const parsed = JSON.parse(rawText) as LinkupApiResponse
        return {
            error: {
                code: status,
                message: parsed.error?.message || rawText,
                details: parsed.error?.details,
            },
        }
    } catch {
        return { error: { code: status, message: rawText } }
    }
}

function formatResultsMarkdown(
    query: string,
    maxResults: number,
    domains: string[] | undefined,
    fromDate: string | undefined,
    toDate: string | undefined,
    response: LinkupApiResponse,
): string {
    const lines: string[] = []

    lines.push(`### Linkup search results for "${escapeMd(query)}"`)
    lines.push('')
    lines.push(`- Max results: \`${maxResults}\``)
    if (domains && domains.length > 0) {
        lines.push(`- Only search these domains: ${domains.map((d) => `\`${escapeMd(d)}\``).join(', ')}`)
    }
    if (fromDate || toDate) {
        lines.push(`- Date filter: from \`${fromDate ?? '-'}\` to \`${toDate ?? '-'}\``)
    }
    lines.push('')

    const items = response.results ?? []
    if (items.length > 0) {
        items.forEach((item, idx) => {
            const title = item.name?.trim() || `Result ${idx + 1}`
            const content = item.content?.trim() || item.snippet?.trim() || ''
            lines.push(`${idx + 1}. [${escapeMd(title)}](${item.url || '#'})`)
            if (content) lines.push(`   ${escapeMd(content)}`)
            lines.push('')
        })
        return lines.join('\n')
    }

    if (response.answer && response.answer.trim().length > 0) {
        lines.push(response.answer.trim())
        lines.push('')
        const sources = response.sources ?? []
        if (sources.length > 0) {
            lines.push('#### Sources')
            lines.push('')
            sources.forEach((source, idx) => {
                const name = source.name?.trim() || `Source ${idx + 1}`
                lines.push(`${idx + 1}. [${escapeMd(name)}](${source.url || '#'})`)
                if (source.snippet) lines.push(`   ${escapeMd(source.snippet)}`)
                lines.push('')
            })
        }
        return lines.join('\n')
    }

    lines.push('No results found.')
    return lines.join('\n')
}

async function performLinkupSearch(input: LinkupSearchInput, token: CancellationToken): Promise<LinkupApiResponse | LinkupSearchError> {
    const query = normalizeQuery(input.query)
    const maxResults = normalizeMaxResults(input.maxResults)
    const domains = normalizeDomains(input.onlySearchTheseDomains)
    const fromDate = normalizeDate(input.dateFilter?.fromDate ?? input.fromDate)
    const toDate = normalizeDate(input.dateFilter?.toDate ?? input.toDate)

    let apiKey = await getLinkupApiKey()

    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())

    try {
        while (true) {
            apiKey = await getLinkupApiKey() || ''
            const payload: Record<string, unknown> = {
                q: query,
                depth: 'standard',
                outputType: 'searchResults',
                includeImages: false,
                maxResults,
            }

            if (domains && domains.length > 0) payload.includeDomains = domains
            if (fromDate) payload.fromDate = fromDate
            if (toDate) payload.toDate = toDate

            const res = await fetch('https://api.linkup.so/v1/search', {
                signal: controller.signal,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'reliefpilot-extension',
                },
                body: JSON.stringify(payload),
            })

            const text = await res.text().catch(() => '')

            if (res.ok) {
                try {
                    return JSON.parse(text) as LinkupApiResponse
                } catch {
                    return { error: { code: 500, message: 'Failed to parse Linkup response' } }
                }
            }

            if (res.status === 401) {
                const shouldRetry = await validateLinkupTokenFromResponse(res.status, text)
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

export class LinkupSearchTool implements LanguageModelTool<LinkupSearchInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<LinkupSearchInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
        const session = createLinkupContentSession(uid, 'linkup_search')

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

            const input = options.input ?? ({} as LinkupSearchInput)
            const query = normalizeQuery(input.query)
            const maxResults = normalizeMaxResults(input.maxResults)
            const domains = normalizeDomains(input.onlySearchTheseDomains)
            const fromDate = normalizeDate(input.dateFilter?.fromDate ?? input.fromDate)
            const toDate = normalizeDate(input.dateFilter?.toDate ?? input.toDate)

            const response = await performLinkupSearch(input, token)
            if ((response as LinkupSearchError).error) {
                const original = JSON.stringify(response, null, 2)
                const body = `linkup_search error (original response):\n${original}`
                session.contentBuffer = body
                try { session.contentEmitter.fire(session.contentBuffer) } catch { }
                throw new Error(original)
            }

            const body = formatResultsMarkdown(query, maxResults, domains, fromDate, toDate, response as LinkupApiResponse)
            session.contentBuffer = body
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const errorBody = `linkup_search error: ${message}`
            session.contentBuffer = errorBody
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }

            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                throw new Error(message)
            }

            throw err instanceof Error ? err : new Error(message)
        } finally {
            finalizeLinkupSession(uid)
            statusBarActivity.end('linkup_search')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<LinkupSearchInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('linkup_search')

        const input = options.input ?? ({} as LinkupSearchInput)
        const query = input.query ?? '<missing-query>'
        const maxResults = input.maxResults
        const domains = input.onlySearchTheseDomains
        const fromDate = input.dateFilter?.fromDate ?? input.fromDate
        const toDate = input.dateFilter?.toDate ?? input.toDate

        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true

        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)

        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **linkup_search**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Query: \`${query}\`  \n`)
        if (Array.isArray(domains) && domains.length > 0) {
            md.appendMarkdown(`• Only search these domains: ${domains.map((d) => `\`${d}\``).join(', ')}  \n`)
        }
        if (fromDate || toDate) {
            md.appendMarkdown(`• Date filter: from \`${fromDate ?? '-'}\` to \`${toDate ?? '-'}\`  \n`)
        }
        if (typeof maxResults === 'number') {
            md.appendMarkdown(`• Max results: \`${maxResults}\`  \n`)
        }

        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.linkup.showContent?${cmdArgs})`)

        return { invocationMessage: md }
    }
}
