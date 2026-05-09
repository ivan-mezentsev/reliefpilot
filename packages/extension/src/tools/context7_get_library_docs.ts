import { randomUUID } from 'node:crypto'
import type {
    CancellationToken,
    LanguageModelTool,
    LanguageModelToolInvocationOptions,
    LanguageModelToolInvocationPrepareOptions,
    PreparedToolInvocation,
} from 'vscode'
import * as vscode from 'vscode'
import { fetchContext7 } from '../utils/context7_auth'
import { createContext7ContentSession, finalizeContext7Session } from '../utils/context7_content_sessions'
import { env } from '../utils/env'
import { haltForFeedbackController } from '../utils/haltForFeedbackController'
import { statusBarActivity } from '../utils/statusBar'

export interface Context7GetLibraryDocsInput {
    context7CompatibleLibraryID: string
    topic?: string
    tokens?: number
}

const DEFAULT_MINIMUM_TOKENS = 6000

function normalizeId(raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error('Missing required parameter: context7CompatibleLibraryID')
    }
    return raw.trim()
}

function normalizeTokens(raw?: number): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
    return raw < DEFAULT_MINIMUM_TOKENS ? DEFAULT_MINIMUM_TOKENS : Math.trunc(raw)
}

function normalizeTopic(raw?: string): string | undefined {
    if (!raw || typeof raw !== 'string') return undefined
    const t = raw.trim()
    return t.length === 0 ? undefined : t
}

async function fetchDocs(id: string, token: CancellationToken, tokens?: number, topic?: string): Promise<string | undefined> {
    // Strip leading slash to mirror server behavior
    const cleanId = id.startsWith('/') ? id.slice(1) : id
    const base = `https://context7.com/api/v1/${cleanId}`
    const url = new URL(base)
    if (typeof tokens === 'number') url.searchParams.set('tokens', String(tokens))
    if (topic) url.searchParams.set('topic', topic)
    url.searchParams.set('type', 'txt')
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchContext7(url.toString(), controller.signal)
        if (!res.ok) return undefined
        const text = await res.text()
        if (!text || text === 'No content available' || text === 'No context data available') return undefined
        return text
    } finally {
        sub.dispose()
    }
}

export class Context7GetLibraryDocsTool implements LanguageModelTool<Context7GetLibraryDocsInput> {
    private _pendingUids: string[] = []
    async invoke(
        options: LanguageModelToolInvocationOptions<Context7GetLibraryDocsInput>,
        token: CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        // Spinner is started in prepareInvocation to indicate activity from the very beginning
        try {
            // Halt for Feedback integration: gate before any network requests or heavy work.
            let state = haltForFeedbackController.getSnapshot()
            if (state.kind === 'paused') {
                state = await haltForFeedbackController.waitUntilNotPaused(token)
            }

            // Respect VS Code cancellation while waiting in paused state.
            if (token.isCancellationRequested) {
                // Keep current tool contract on cancellation: throw and let the existing catch format it.
                throw new Error('This operation was aborted')
            }

            if (state.kind === 'declined') {
                haltForFeedbackController.takeDeclineAndReset()
                throw new Error('Tool execution was declined by the user. Feedback: ' + state.feedback)
            }

            const id = normalizeId(options.input?.context7CompatibleLibraryID)
            const topic = normalizeTopic(options.input?.topic)
            const tokensVal = normalizeTokens(options.input?.tokens)
            const docs = await fetchDocs(id, token, tokensVal, topic)
            if (!docs) {
                const msg = 'Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID. To get a valid ID, call context7_resolve-library-id first.'
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(msg)])
            }
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createContext7ContentSession(uid, 'context7_get-library-docs')
            session.contentBuffer = docs
            try { session.contentEmitter.fire(session.contentBuffer) } catch { /* ignore */ }
            finalizeContext7Session(uid)
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(docs)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                // Preserve exact error format
                throw new Error(message)
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`context7_get-library-docs error: ${message}`),
            ])
        } finally {
            // Stop unified Context7 activity indicator upon tool completion
            statusBarActivity.end('context7')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<Context7GetLibraryDocsInput>,
    ): PreparedToolInvocation {
        // Start unified Context7 spinner as early as possible (at prepare phase)
        statusBarActivity.start('context7')
        const id = options.input?.context7CompatibleLibraryID ?? '<missing-context7CompatibleLibraryID>'
        const topic = options.input?.topic
        const tokensVal = options.input?.tokens
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **context7_get-library-docs**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• ID: \`${id}\`  \n`)
        if (topic) md.appendMarkdown(`• Topic: \`${topic}\`  \n`)
        if (typeof tokensVal === 'number') md.appendMarkdown(`• Tokens: \`${tokensVal}\`  \n`)
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.context7.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
