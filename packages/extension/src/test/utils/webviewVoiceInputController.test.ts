import * as assert from 'assert'
import type { StreamingRecordingSession } from '../../utils/speechToText'
import { resetSpeechSessionArbiterForTests } from '../../utils/speechSessionArbiter'
import { resetVoiceInputPanelRegistryForTests } from '../../utils/voiceInputPanelRegistry'
import { createWebviewVoiceInputController } from '../../utils/webviewVoiceInputController'

function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

function createFakePanel(active = true) {
    const postedMessages: unknown[] = []
    const panel = {
        active,
        webview: {
            postMessage: async (message: unknown) => {
                postedMessages.push(message)
                return true
            },
        },
    } as any

    return {
        panel,
        postedMessages,
    }
}

function createStartStreamingRecordingStub() {
    const sessions: Array<{
        cancelCalls: number
        stopCalls: number
        emitText: (text: string) => void
        emitEnd: () => void
        emitError: (message: string) => void
        session: StreamingRecordingSession
    }> = []

    const startStreamingRecording = (opts: {
        onText: (text: string) => void
        onEnd: () => void
        onCancel?: () => void
        onError: (err: Error) => void
    }) => {
        const control = {
            cancelCalls: 0,
            stopCalls: 0,
            emitText: (text: string) => opts.onText(text),
            emitEnd: () => opts.onEnd(),
            emitError: (message: string) => opts.onError(new Error(message)),
            session: {
                stop: () => {
                    control.stopCalls++
                    opts.onEnd()
                },
                cancel: () => {
                    control.cancelCalls++
                },
            } satisfies StreamingRecordingSession,
        }

        sessions.push(control)
        return control.session
    }

    return {
        startStreamingRecording,
        sessions,
    }
}

suite('webviewVoiceInputController', () => {
    teardown(() => {
        resetSpeechSessionArbiterForTests()
        resetVoiceInputPanelRegistryForTests()
    })

    test('forwards speech results and end events to the webview', async () => {
        const { panel, postedMessages } = createFakePanel(true)
        const { startStreamingRecording, sessions } = createStartStreamingRecordingStub()

        const controller = createWebviewVoiceInputController({
            panel,
            _test: {
                ensureSpeechApiKeyPrompted: async () => true,
                showErrorMessage: () => undefined,
                startStreamingRecording,
            },
        })

        assert.strictEqual(controller.handleMessage({ type: 'startRecording' }), true)
        await flushMicrotasks()

        assert.strictEqual(sessions.length, 1)

        sessions[0].emitText('hello world')
        sessions[0].emitEnd()

        assert.deepStrictEqual(postedMessages, [
            { type: 'speechResult', text: 'hello world' },
            { type: 'speechEnded' },
        ])

        controller.dispose()
    })

    test('does not start recording when auth prompt is dismissed', async () => {
        const { panel, postedMessages } = createFakePanel(true)
        const { startStreamingRecording, sessions } = createStartStreamingRecordingStub()

        const controller = createWebviewVoiceInputController({
            panel,
            _test: {
                ensureSpeechApiKeyPrompted: async () => false,
                showErrorMessage: () => undefined,
                startStreamingRecording,
            },
        })

        assert.strictEqual(controller.handleMessage({ type: 'startRecording' }), true)
        await flushMicrotasks()

        assert.strictEqual(sessions.length, 0)
        assert.deepStrictEqual(postedMessages, [{ type: 'speechEnded' }])

        controller.dispose()
    })

    test('preempts the previous panel session via the shared arbiter', async () => {
        const first = createFakePanel(true)
        const second = createFakePanel(true)
        const { startStreamingRecording, sessions } = createStartStreamingRecordingStub()

        const firstController = createWebviewVoiceInputController({
            panel: first.panel,
            _test: {
                ensureSpeechApiKeyPrompted: async () => true,
                showErrorMessage: () => undefined,
                startStreamingRecording,
            },
        })
        const secondController = createWebviewVoiceInputController({
            panel: second.panel,
            _test: {
                ensureSpeechApiKeyPrompted: async () => true,
                showErrorMessage: () => undefined,
                startStreamingRecording,
            },
        })

        firstController.handleMessage({ type: 'startRecording' })
        await flushMicrotasks()
        assert.strictEqual(sessions.length, 1)

        secondController.handleMessage({ type: 'startRecording' })
        await flushMicrotasks()

        assert.strictEqual(sessions.length, 2)
        assert.strictEqual(sessions[0].cancelCalls, 1)
        assert.deepStrictEqual(first.postedMessages, [{ type: 'speechEnded' }])

        firstController.dispose()
        secondController.dispose()
    })
})