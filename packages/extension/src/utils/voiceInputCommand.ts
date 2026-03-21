import * as vscode from 'vscode'
import { getActiveVoiceInputPanel } from './voiceInputPanelRegistry'

export const NO_ACTIVE_VOICE_INPUT_PANEL_MESSAGE =
    'Voice input is available only when an interactive Ask Report or Halt for Feedback panel is active.'

export async function toggleActiveVoiceInput(opts?: {
    getActiveVoiceInputPanel?: () => vscode.WebviewPanel | undefined
    showInformationMessage?: (message: string) => Thenable<unknown> | unknown
}): Promise<boolean> {
    const panel = (opts?.getActiveVoiceInputPanel ?? getActiveVoiceInputPanel)()
    if (!panel) {
        await (opts?.showInformationMessage ?? vscode.window.showInformationMessage)(
            NO_ACTIVE_VOICE_INPUT_PANEL_MESSAGE,
        )
        return false
    }

    await panel.webview.postMessage({ type: 'toggleRecording' })
    return true
}