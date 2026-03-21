import * as vscode from 'vscode'
import { ensureSpeechApiKeyPrompted } from './speech_auth'
import {
    cancelActiveSpeechSession,
    releaseActiveSpeechSession,
    replaceActiveSpeechSession,
    stopActiveSpeechSession,
} from './speechSessionArbiter'
import { startStreamingRecording, type StreamingRecordingSession } from './speechToText'
import { registerVoiceInputPanel } from './voiceInputPanelRegistry'

let nextVoiceControllerId = 1

export function createWebviewVoiceInputController(opts: {
    panel: vscode.WebviewPanel
    enableVoiceInput?: boolean
    onBeforeStart?: () => void
    _test?: {
        startStreamingRecording?: typeof startStreamingRecording
        ensureSpeechApiKeyPrompted?: typeof ensureSpeechApiKeyPrompted
        showErrorMessage?: (message: string) => Thenable<unknown> | unknown
    }
}) {
    const voiceControllerId = nextVoiceControllerId++
    const panelRegistration = opts.enableVoiceInput === false
        ? undefined
        : registerVoiceInputPanel(opts.panel)
    let activeRecording: StreamingRecordingSession | undefined
    let activeSessionToken: string | undefined
    let nextRequestId = 0
    let pendingStartRequestId: number | undefined

    function postVoiceState(type: 'speechEnded' | 'speechError') {
        void opts.panel.webview.postMessage({ type })
    }

    function showVoiceError(message: string) {
        void (opts._test?.showErrorMessage ?? vscode.window.showErrorMessage)(message)
    }

    function finalizeActiveSession(sessionToken: string, type: 'speechEnded' | 'speechError') {
        if (activeSessionToken !== sessionToken) return

        releaseActiveSpeechSession(sessionToken)
        activeRecording = undefined
        activeSessionToken = undefined
        postVoiceState(type)
    }

    async function startRecordingSession() {
        if (opts.enableVoiceInput === false) return
        if (activeRecording || pendingStartRequestId !== undefined) return

        const requestId = ++nextRequestId
        pendingStartRequestId = requestId

        try {
            const proceed = await (opts._test?.ensureSpeechApiKeyPrompted ?? ensureSpeechApiKeyPrompted)()
            if (pendingStartRequestId !== requestId) return
            if (!proceed) {
                pendingStartRequestId = undefined
                postVoiceState('speechEnded')
                return
            }
        } catch (err) {
            if (pendingStartRequestId !== requestId) return
            pendingStartRequestId = undefined
            showVoiceError(`Voice error: ${err instanceof Error ? err.message : String(err)}`)
            postVoiceState('speechError')
            return
        }

        try {
            opts.onBeforeStart?.()
        } catch {
            // ignore UI preparation errors and still attempt to record
        }

        if (pendingStartRequestId !== requestId) return

        const sessionToken = `${voiceControllerId}:${requestId}`
        activeSessionToken = sessionToken

        try {
            const session = replaceActiveSpeechSession({
                token: sessionToken,
                onPreempted: () => {
                    if (activeSessionToken !== sessionToken) return

                    activeRecording = undefined
                    activeSessionToken = undefined
                    pendingStartRequestId = undefined
                    postVoiceState('speechEnded')
                },
                createSession: () => {
                    const startRecording = opts._test?.startStreamingRecording ?? startStreamingRecording
                    return startRecording({
                        onText: (text: string) => {
                            if (activeSessionToken !== sessionToken) return
                            void opts.panel.webview.postMessage({ type: 'speechResult', text })
                        },
                        onEnd: () => {
                            finalizeActiveSession(sessionToken, 'speechEnded')
                        },
                        onCancel: () => {
                            finalizeActiveSession(sessionToken, 'speechEnded')
                        },
                        onError: (err: Error) => {
                            if (activeSessionToken !== sessionToken) return

                            releaseActiveSpeechSession(sessionToken)
                            activeRecording = undefined
                            activeSessionToken = undefined
                            pendingStartRequestId = undefined
                            showVoiceError(`Voice error: ${err?.message || 'unknown'}`)
                            postVoiceState('speechError')
                        },
                    })
                },
            })

            if (pendingStartRequestId !== requestId) {
                cancelActiveSpeechSession(sessionToken)
                activeSessionToken = undefined
                return
            }

            activeRecording = session
            pendingStartRequestId = undefined
        } catch (err) {
            if (pendingStartRequestId !== requestId) return

            pendingStartRequestId = undefined
            activeSessionToken = undefined
            showVoiceError(`Voice error: ${err instanceof Error ? err.message : String(err)}`)
            postVoiceState('speechError')
        }
    }

    function stopRecordingSession() {
        if (opts.enableVoiceInput === false) return

        if (pendingStartRequestId !== undefined) {
            pendingStartRequestId = undefined
            postVoiceState('speechEnded')
            return
        }

        const rec = activeRecording
        const sessionToken = activeSessionToken
        activeRecording = undefined

        if (sessionToken && stopActiveSpeechSession(sessionToken)) {
            return
        }

        rec?.stop()
    }

    return {
        handleMessage(msg: unknown): boolean {
            if (!msg || typeof msg !== 'object') return false

            const type = (msg as { type?: unknown }).type
            if (type === 'startRecording') {
                void startRecordingSession()
                return true
            }

            if (type === 'stopRecording') {
                stopRecordingSession()
                return true
            }

            return false
        },
        dispose() {
            pendingStartRequestId = undefined

            if (activeSessionToken) {
                cancelActiveSpeechSession(activeSessionToken)
            }

            activeSessionToken = undefined
            activeRecording = undefined
            panelRegistration?.dispose()
        },
    }
}