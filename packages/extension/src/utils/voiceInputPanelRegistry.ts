import * as vscode from 'vscode'

const registeredVoiceInputPanels = new Map<number, vscode.WebviewPanel>()
let nextRegistrationId = 1

export function registerVoiceInputPanel(panel: vscode.WebviewPanel): vscode.Disposable {
    const registrationId = nextRegistrationId++
    registeredVoiceInputPanels.set(registrationId, panel)

    return new vscode.Disposable(() => {
        registeredVoiceInputPanels.delete(registrationId)
    })
}

export function getActiveVoiceInputPanel(): vscode.WebviewPanel | undefined {
    const activePanels = [...registeredVoiceInputPanels.values()].filter((panel) => panel.active)
    if (activePanels.length !== 1) {
        return undefined
    }

    return activePanels[0]
}

/** @internal test-only */
export function resetVoiceInputPanelRegistryForTests(): void {
    registeredVoiceInputPanels.clear()
}