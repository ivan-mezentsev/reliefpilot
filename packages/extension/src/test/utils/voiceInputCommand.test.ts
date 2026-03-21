import * as assert from 'assert'
import * as vscode from 'vscode'
import {
    NO_ACTIVE_VOICE_INPUT_PANEL_MESSAGE,
    toggleActiveVoiceInput,
} from '../../utils/voiceInputCommand'

suite('voiceInputCommand', () => {
    test('fails closed when there is no active voice input panel', async () => {
        const shownMessages: string[] = []

        const handled = await toggleActiveVoiceInput({
            getActiveVoiceInputPanel: () => undefined,
            showInformationMessage: (message) => {
                shownMessages.push(message)
            },
        })

        assert.strictEqual(handled, false)
        assert.deepStrictEqual(shownMessages, [NO_ACTIVE_VOICE_INPUT_PANEL_MESSAGE])
    })

    test('posts toggleRecording to the active voice input panel', async () => {
        const postedMessages: unknown[] = []
        const panel = {
            webview: {
                postMessage: async (message: unknown) => {
                    postedMessages.push(message)
                    return true
                },
            },
        } as unknown as vscode.WebviewPanel

        const handled = await toggleActiveVoiceInput({
            getActiveVoiceInputPanel: () => panel,
        })

        assert.strictEqual(handled, true)
        assert.deepStrictEqual(postedMessages, [{ type: 'toggleRecording' }])
    })
})