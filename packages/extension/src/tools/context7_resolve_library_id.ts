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

// Input shape for context7_resolve-library-id
export interface Context7ResolveLibraryIdInput {
    libraryName: string
}

// Minimal search response types matching Context7 API (subset)
interface Context7SearchResult {
    id: string
    title: string
    description: string
    totalSnippets?: number
    trustScore?: number
    versions?: string[]
}
interface Context7SearchResponse {
    results: Context7SearchResult[]
}

function normalizeLibraryName(raw?: string): string {
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error('Missing required parameter: libraryName')
    }
    return raw.trim()
}

function formatResult(r: Context7SearchResult): string {
    const lines: string[] = []
    lines.push(`- Title: ${r.title}`)
    lines.push(`- Context7-compatible library ID: ${r.id}`)
    lines.push(`- Description: ${r.description}`)
    if (typeof r.totalSnippets === 'number' && r.totalSnippets >= 0) {
        lines.push(`- Code Snippets: ${r.totalSnippets}`)
    }
    if (typeof r.trustScore === 'number' && r.trustScore >= 0) {
        lines.push(`- Trust Score: ${r.trustScore.toFixed(1)}`)
    }
    if (Array.isArray(r.versions) && r.versions.length > 0) {
        lines.push(`- Versions: ${r.versions.join(', ')}`)
    }
    return lines.join('\n')
}

function formatResults(resp: Context7SearchResponse): string {
    if (!resp.results || resp.results.length === 0) {
        return 'No documentation libraries found matching your query.'
    }
    return resp.results.map(formatResult).join('\n----------\n')
}

async function searchLibraries(query: string, token: CancellationToken): Promise<Context7SearchResponse | undefined> {
    const base = 'https://context7.com/api/v1/search'
    const url = `${base}?query=${encodeURIComponent(query)}`
    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
        const res = await fetchContext7(url, controller.signal)
        if (!res.ok) {
            return undefined
        }
        const data = await res.json()
        return data as Context7SearchResponse
    } finally {
        sub.dispose()
    }
}

export class Context7ResolveLibraryIdTool implements LanguageModelTool<Context7ResolveLibraryIdInput> {
    private _pendingUids: string[] = []
    async invoke(
        options: LanguageModelToolInvocationOptions<Context7ResolveLibraryIdInput>,
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

            const name = normalizeLibraryName(options.input?.libraryName)
            const resp = await searchLibraries(name, token)
            if (!resp) {
                throw new Error('Failed to retrieve library documentation data from Context7')
            }
            const body = formatResults(resp)
            // Mirror reference tool framing text
            const prefix = `Available Libraries (top matches):\n\nEach result includes:\n- Library ID: Context7-compatible identifier (format: /org/project)\n- Name: Library or package name\n- Description: Short summary\n- Code Snippets: Number of available code examples\n- Trust Score: Authority indicator\n- Versions: List of versions if available. Use one of those versions if and only if the user explicitly provides a version in their query.\n\nFor best results, select libraries based on name match, trust score, snippet coverage, and relevance to your use case.\n\n----------\n\n${body}`
            // Attach content to session (create after successful retrieval)
            const uid = this._pendingUids.length > 0 ? this._pendingUids.shift()! : randomUUID()
            const session = createContext7ContentSession(uid, 'context7_resolve-library-id')
            session.contentBuffer = prefix
            try { session.contentEmitter.fire(session.contentBuffer) } catch { /* ignore */ }
            finalizeContext7Session(uid)
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(prefix)])
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (typeof message === 'string' && message.startsWith('Tool execution was declined by the user.')) {
                // Preserve exact error format
                throw new Error(message)
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`context7_resolve-library-id error: ${message}`),
            ])
        } finally {
            // Stop unified Context7 activity indicator upon tool completion
            statusBarActivity.end('context7')
        }
    }

    prepareInvocation(
        options: LanguageModelToolInvocationPrepareOptions<Context7ResolveLibraryIdInput>,
    ): PreparedToolInvocation {
        // Start unified Context7 spinner as early as possible (at prepare phase)
        statusBarActivity.start('context7')
        const lib = options.input?.libraryName ?? '<missing-libraryName>'
        const md = new vscode.MarkdownString(undefined, true)
        md.supportHtml = true
        md.isTrusted = true
        const showPauseButton = vscode.workspace
            .getConfiguration('reliefpilot')
            .get<boolean>('showPauseButtonInChat', true)
        const iconUri = vscode.Uri.joinPath(env.extensionUri, 'icon.png')
        md.appendMarkdown(`![Relief Pilot](${iconUri.toString()}|width=10,height=10) `)
        md.appendMarkdown(`Relief Pilot · **context7_resolve-library-id**${showPauseButton ? ' [⏸](command:reliefpilot.haltForFeedback)' : ''}  \n`)
        md.appendMarkdown(`• Query: \`${lib}\`  \n`)
        // Generate UID and embed show content command link
        const uid = randomUUID()
        this._pendingUids.push(uid)
        const cmdArgs = encodeURIComponent(JSON.stringify({ uid }))
        md.appendMarkdown(`\n[Show content](command:reliefpilot.context7.showContent?${cmdArgs})`)
        return { invocationMessage: md }
    }
}
