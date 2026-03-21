import * as assert from 'assert'
import * as vscode from 'vscode'
import {
    getActiveVoiceInputPanel,
    registerVoiceInputPanel,
    resetVoiceInputPanelRegistryForTests,
} from '../../utils/voiceInputPanelRegistry'

suite('voiceInputPanelRegistry', () => {
    teardown(() => {
        resetVoiceInputPanelRegistryForTests()
    })

    test('returns the active registered panel', () => {
        const inactivePanel = { active: false } as vscode.WebviewPanel
        const activePanel = { active: true } as vscode.WebviewPanel

        const disposeInactive = registerVoiceInputPanel(inactivePanel)
        const disposeActive = registerVoiceInputPanel(activePanel)

        assert.strictEqual(getActiveVoiceInputPanel(), activePanel)

        disposeActive.dispose()
        disposeInactive.dispose()
    })

    test('returns undefined when no registered panel is active', () => {
        const inactivePanel = { active: false } as vscode.WebviewPanel
        const disposeInactive = registerVoiceInputPanel(inactivePanel)

        assert.strictEqual(getActiveVoiceInputPanel(), undefined)

        disposeInactive.dispose()
    })
})