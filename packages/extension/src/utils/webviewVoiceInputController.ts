import * as vscode from 'vscode'
import { startStreamingRecording, type StreamingRecordingSession } from './speechToText'

export function createWebviewVoiceInputController(opts: {
    panel: vscode.WebviewPanel
    enableVoiceInput?: boolean
    onBeforeStart?: () => void
}) {
    let activeRecording: StreamingRecordingSession | undefined
    let recordingSessionId = 0

    function postVoiceState(type: 'speechEnded' | 'speechError') {
        void opts.panel.webview.postMessage({ type })
    }

    function finalizeActiveSession(myId: number, type: 'speechEnded' | 'speechError') {
        if (recordingSessionId !== myId) return
        activeRecording = undefined
        postVoiceState(type)
    }

    function startRecordingSession() {
        if (opts.enableVoiceInput === false) return

        activeRecording?.cancel()
        recordingSessionId++
        const myId = recordingSessionId

        try {
            opts.onBeforeStart?.()
        } catch {
            // ignore UI preparation errors and still attempt to record
        }

        const session = startStreamingRecording({
            onText: (text: string) => {
                if (recordingSessionId !== myId) return
                void opts.panel.webview.postMessage({ type: 'speechResult', text })
            },
            onEnd: () => {
                finalizeActiveSession(myId, 'speechEnded')
            },
            onCancel: () => {
                finalizeActiveSession(myId, 'speechEnded')
            },
            onError: (err: Error) => {
                if (recordingSessionId !== myId) return
                activeRecording = undefined
                void vscode.window.showErrorMessage(`Voice error: ${err?.message || 'unknown'}`)
                postVoiceState('speechError')
            },
        })

        activeRecording = session
    }

    function stopRecordingSession() {
        if (opts.enableVoiceInput === false) return

        const rec = activeRecording
        activeRecording = undefined
        rec?.stop()
    }

    return {
        handleMessage(msg: unknown): boolean {
            if (!msg || typeof msg !== 'object') return false

            const type = (msg as { type?: unknown }).type
            if (type === 'startRecording') {
                startRecordingSession()
                return true
            }

            if (type === 'stopRecording') {
                stopRecordingSession()
                return true
            }

            return false
        },
        dispose() {
            recordingSessionId++
            activeRecording?.cancel()
            activeRecording = undefined
        },
    }
}