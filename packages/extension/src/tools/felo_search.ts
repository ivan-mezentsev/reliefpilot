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
import { createFeloContentSession, finalizeFeloSession } from '../utils/felo_search_content_sessions'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { statusBarActivity } from '../utils/statusBar'

export interface FeloSearchInput {
    query: string
}

interface FeloStreamDataContent { text?: string }
interface FeloStreamData { type?: string; data?: FeloStreamDataContent }

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edge/120.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

function pickUserAgent(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] || USER_AGENTS[0]
}

function normalizeQuery(raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error('Missing required parameter: query')
    }
    return raw.trim()
}

async function performFeloSearch(
    input: FeloSearchInput,
    token: CancellationToken,
    session: ReturnType<typeof createFeloContentSession>,
): Promise<string> {
    const query = normalizeQuery(input.query)

    const payload = {
        query,
        search_uuid: randomUUID(),
        lang: '',
        agent_lang: 'en',
        search_options: { langcode: 'en-US' },
        search_video: true,
        contexts_from: 'google',
    }

    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())

    try {
        const res = await fetch('https://api.felo.ai/search/threads', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'accept': '*/*',
                'accept-encoding': 'gzip, deflate, br',
                'accept-language': 'en-US,en;q=0.9',
                'content-type': 'application/json',
                'cookie': '_clck=1gifk45%7C2%7Cfoa%7C0%7C1686; _clsk=1g5lv07%7C1723558310439%7C1%7C1%7Cu.clarity.ms%2Fcollect; _ga=GA1.1.877307181.1723558313; _ga_8SZPRV97HV=GS1.1.1723558313.1.1.1723558341.0.0.0; _ga_Q9Q1E734CC=GS1.1.1723558313.1.1.1723558341.0.0.0',
                'dnt': '1',
                'origin': 'https://felo.ai',
                'referer': 'https://felo.ai/',
                'sec-ch-ua': '"Not)A;Brand";v="99", "Microsoft Edge";v="127", "Chromium";v="127"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                'user-agent': pickUserAgent(),
            },
            body: JSON.stringify(payload),
        })

        const errText = !res.ok ? await res.text().catch(() => '') : ''
        if (!res.ok) {
            throw new Error(`Felo API request failed: ${res.status} - ${errText}`)
        }

        let fullResponse = ''
        const decoder = new TextDecoder()
        const reader = res.body?.getReader()
        let buf = ''
        if (!reader) {
            // Fallback: read full text if stream API not exposed
            const txt = await res.text().catch(() => '')
            fullResponse = txt || 'No response received from Felo AI.'
        } else {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buf += decoder.decode(value, { stream: true })
                const lines = buf.split(/\r?\n/)
                buf = lines.pop() || '' // retain incomplete trailing line
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue
                    const dataPart = line.slice(5).trim()
                    if (!dataPart || dataPart === '[DONE]') continue
                    try {
                        const parsed: FeloStreamData = JSON.parse(dataPart)
                        if (parsed.type === 'answer') {
                            const text = parsed.data?.text || ''
                            if (text.length > fullResponse.length) {
                                fullResponse = text
                                session.contentBuffer = fullResponse
                                try { session.contentEmitter.fire(session.contentBuffer) } catch { }
                            }
                        }
                    } catch { /* ignore parse errors */ }
                }
            }
            // Process any remaining buffered line
            if (buf.startsWith('data:')) {
                const dataPart = buf.slice(5).trim()
                if (dataPart && dataPart !== '[DONE]') {
                    try {
                        const parsed: FeloStreamData = JSON.parse(dataPart)
                        if (parsed.type === 'answer') {
                            const text = parsed.data?.text || ''
                            if (text.length > fullResponse.length) fullResponse = text
                        }
                    } catch { }
                }
            }
        }

        if (!fullResponse) {
            return 'No response received from Felo AI.'
        }
        return fullResponse
    } finally {
        sub.dispose()
    }
}

export class FeloSearchTool implements LanguageModelTool<FeloSearchInput> {
    private _pendingUids: string[] = []

    async invoke(
        options: LanguageModelToolInvocationOptions<FeloSearchInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
        const session = createFeloContentSession(uid, 'felo_search')
        try {
            // Halt for Feedback integration: gate before any network requests.
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

            const input = options.input ?? ({} as FeloSearchInput)
            const answer = await performFeloSearch(input, token, session)
            const body = answer
            session.contentBuffer = body
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const errorBody = `felo_search error: ${message}`
            session.contentBuffer = errorBody
            try { session.contentEmitter.fire(session.contentBuffer) } catch { }

            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                // Preserve exact error format
                throw new Error(message)
            }

            throw err instanceof Error ? err : new Error(message)
        } finally {
            finalizeFeloSession(uid)
            statusBarActivity.end('felo_search')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<FeloSearchInput>,
    ): PreparedToolInvocation {
        statusBarActivity.start('felo_search')
        const input = options.input ?? ({} as FeloSearchInput)
        const q = input.query ?? '<missing-query>'
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **felo_search**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Query: \`${q}\`  \n`)

        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.felo.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
