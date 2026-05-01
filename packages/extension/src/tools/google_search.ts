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
import { getGoogleApiKey, getGoogleSearchEngineId } from '../utils/google_search_auth'
import { createGoogleContentSession, finalizeGoogleSession } from '../utils/google_search_content_sessions'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { statusBarActivity } from '../utils/statusBar'
import { validateGoogleTokensFromResponse } from '../utils/validate_google_tokens'

export interface GoogleSearchInput {
    query: string
    num_results?: number
    site?: string
    language?: string
    dateRestrict?: string
    exactTerms?: string
    resultType?: string
    page?: number
    resultsPerPage?: number
    sort?: string
}

interface GoogleCseItem {
    title: string
    link: string
    snippet?: string
}

interface GoogleCseQueriesPage {
    startIndex?: number
}

interface GoogleCseResponse {
    items?: GoogleCseItem[]
    searchInformation?: { totalResults?: string }
    queries?: {
        nextPage?: GoogleCseQueriesPage[]
        previousPage?: GoogleCseQueriesPage[]
        request?: Array<{ totalResults?: string }>
    }
    error?: { code?: number; message?: string; errors?: Array<{ message?: string; reason?: string }> }
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

function normalizeResultsPerPage(raw?: number): number {
    return normalizePositiveInt(raw, 5, 1, 10)
}

function normalizePage(raw?: number): number {
    return normalizePositiveInt(raw, 1, 1, Number.MAX_SAFE_INTEGER)
}

function buildGoogleUrl(params: {
    apiKey: string
    cx: string
    query: string
    num: number
    start: number
    site?: string
    language?: string
    dateRestrict?: string
    exactTerms?: string
    resultType?: string
    sort?: string
}): string {
    const base = 'https://www.googleapis.com/customsearch/v1'
    const url = new URL(base)
    url.searchParams.set('key', params.apiKey)
    url.searchParams.set('cx', params.cx)
    url.searchParams.set('q', params.query)
    url.searchParams.set('num', String(params.num))
    url.searchParams.set('start', String(params.start))
    if (params.site) {
        url.searchParams.set('siteSearch', params.site)
        url.searchParams.set('siteSearchFilter', 'i')
    }
    if (params.language) {
        const lr = params.language.toLowerCase().startsWith('lang_') ? params.language.toLowerCase() : `lang_${params.language.toLowerCase()}`
        url.searchParams.set('lr', lr)
    }
    if (params.dateRestrict) url.searchParams.set('dateRestrict', params.dateRestrict)
    if (params.exactTerms) url.searchParams.set('exactTerms', params.exactTerms)
    if (params.resultType) {
        const rt = params.resultType.toLowerCase()
        if (rt === 'image' || rt === 'images') url.searchParams.set('searchType', 'image')
    }
    if (params.sort && params.sort.toLowerCase() === 'date') {
        url.searchParams.set('sort', 'date')
    }
    return url.toString()
}

function formatResults(query: string, page: number, items: GoogleCseItem[] | undefined, totalResults?: string, hasPrev?: boolean, hasNext?: boolean): string {
    if (!items || items.length === 0) {
        return 'No results found. Try:\n- Using different keywords\n- Removing quotes from non-exact phrases\n- Using more general terms'
    }

    const lines: string[] = []
    lines.push(`Search results for "${query}":`)
    if (totalResults && Number.isFinite(Number(totalResults))) {
        lines.push('')
        lines.push(`Showing page ${page} of approximately ${totalResults} results`)
    } else {
        lines.push('')
        lines.push(`Showing page ${page}`)
    }
    lines.push('')

    items.forEach((it, idx) => {
        lines.push(`${idx + 1}. ${it.title}`)
        lines.push(`   URL: ${it.link}`)
        if (it.snippet) lines.push(`   ${it.snippet}`)
        lines.push('')
    })

    if (hasPrev || hasNext) {
        const parts: string[] = []
        if (hasPrev && page > 1) parts.push(`Use 'page: ${page - 1}' for previous results.`)
        if (hasNext) parts.push(`Use 'page: ${page + 1}' for more results.`)
        if (parts.length > 0) {
            lines.push(`Navigation: ${parts.join(' ')}`)
        }
    }

    return lines.join('\n')
}

async function performGoogleSearch(
    input: GoogleSearchInput,
    token: CancellationToken,
): Promise<GoogleCseResponse> {
    const query = normalizeQuery(input.query)
    const page = normalizePage(input.page)
    const perPage = normalizeResultsPerPage(input.resultsPerPage ?? input.num_results)
    const start = (page - 1) * perPage + 1

    let apiKey = await getGoogleApiKey()
    let cx = await getGoogleSearchEngineId()

    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())

    try {
        while (true) {
            apiKey = await getGoogleApiKey() || ''
            cx = await getGoogleSearchEngineId() || ''
            const url = buildGoogleUrl({
                apiKey,
                cx,
                query,
                num: perPage,
                start,
                site: input.site,
                language: input.language,
                dateRestrict: input.dateRestrict,
                exactTerms: input.exactTerms,
                resultType: input.resultType,
                sort: input.sort,
            })

            const res = await fetch(url, { signal: controller.signal, method: 'GET', headers: { 'User-Agent': 'reliefpilot-extension' } })
            const text = await res.text().catch(() => '')

            if (res.ok) {
                try {
                    return JSON.parse(text) as GoogleCseResponse
                } catch {
                    return { error: { code: 500, message: 'Failed to parse Google Search response' } }
                }
            }

            if (res.status === 400 || res.status === 403 || res.status === 401) {
                const shouldRetry = await validateGoogleTokensFromResponse(res.status, text)
                if (shouldRetry) {
                    continue
                }
                try {
                    return JSON.parse(text) as GoogleCseResponse
                } catch {
                    return { error: { code: res.status, message: text } }
                }
            }

            try {
                return JSON.parse(text) as GoogleCseResponse
            } catch {
                return { error: { code: res.status, message: text } }
            }
        }
    } finally {
        sub.dispose()
    }
}

export class GoogleSearchTool implements LanguageModelTool<GoogleSearchInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<GoogleSearchInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
        const session = createGoogleContentSession(uid, 'google_search')

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

            const input = options.input ?? ({} as GoogleSearchInput)
            const query = normalizeQuery(input.query)
            const page = normalizePage(input.page)

            const resp = await performGoogleSearch(input, token)
            if (resp.error) {
                const original = JSON.stringify(resp, null, 2)
                const body = `google_search error (original response):\n${original}`
                session.contentBuffer = body
                try { session.contentEmitter.fire(session.contentBuffer) } catch { }
                throw new Error(original)
            }

            const items = resp.items ?? []
            const totalResults = resp.searchInformation?.totalResults || resp.queries?.request?.[0]?.totalResults
            const hasPrev = !!(resp.queries && resp.queries.previousPage && resp.queries.previousPage.length > 0)
            const hasNext = !!(resp.queries && resp.queries.nextPage && resp.queries.nextPage.length > 0)

            const body = formatResults(query, page, items, totalResults, hasPrev, hasNext)
            session.contentBuffer = body
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const errorBody = `google_search error: ${message}`
            session.contentBuffer = errorBody
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }

            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                throw new Error(message)
            }

            throw err instanceof Error ? err : new Error(message)
        } finally {
            finalizeGoogleSession(uid)
            statusBarActivity.end('google_search')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<GoogleSearchInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('google_search')

        const input = options.input ?? ({} as GoogleSearchInput)
        const q = input.query ?? '<missing-query>'
        const page = input.page
        const numRes = input.num_results
        const rpp = input.resultsPerPage
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **google_search**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}\n`)
        md.appendMarkdown(`- Query: \`${q}\`  \n`)
        if (typeof page === 'number') md.appendMarkdown(`- Page: \`${page}\`  \n`)
        if (typeof rpp === 'number') md.appendMarkdown(`- Results Per Page: \`${rpp}\`  \n`)
        if (typeof numRes === 'number') md.appendMarkdown(`- Num Results (cap): \`${numRes}\`  \n`)
        if (input.site) md.appendMarkdown(`- Site: \`${input.site}\`  \n`)
        if (input.language) md.appendMarkdown(`- Language: \`${input.language}\`  \n`)
        if (input.dateRestrict) md.appendMarkdown(`- Date Restrict: \`${input.dateRestrict}\`  \n`)
        if (input.exactTerms) md.appendMarkdown(`- Exact Terms: \`${input.exactTerms}\`  \n`)
        if (input.resultType) md.appendMarkdown(`- Result Type: \`${input.resultType}\`  \n`)
        if (input.sort) md.appendMarkdown(`- Sort: \`${input.sort}\`  \n`)

        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.google.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
