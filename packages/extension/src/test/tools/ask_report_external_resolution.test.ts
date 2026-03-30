import * as assert from 'assert'
import { askReport, cancelAllPendingAskReports, getActiveAskReportPanel, resolveAskReportFromTelegram } from '../../tools/ask_report'

suite('Ask Report external Telegram resolution', function () {
    this.timeout(10000)

    test('resolves a predefined-option ask_report from Telegram callback data', async () => {
        const reportId = `telegram-option-${Date.now()}`
        const resultPromise = askReport({
            title: 'Telegram option resolution',
            markdown: 'Choose one option',
            predefinedOptions: ['Yes', 'No'],
            historyId: reportId,
        })

        const panel = getActiveAskReportPanel()
        assert.ok(panel, 'Expected ask_report panel to be active')

        const state = resolveAskReportFromTelegram(reportId, 'Yes')
        assert.strictEqual(state, 'resolved')

        const result = await resultPromise
        assert.deepStrictEqual(result, { decision: 'Submit', value: 'Yes', source: 'telegram' })
    })

    test('resolves a freeform ask_report from Telegram text reply', async () => {
        const reportId = `telegram-text-${Date.now()}`
        const resultPromise = askReport({
            title: 'Telegram text resolution',
            markdown: 'Reply with any text',
            historyId: reportId,
        })

        const panel = getActiveAskReportPanel()
        assert.ok(panel, 'Expected ask_report panel to be active')

        const state = resolveAskReportFromTelegram(reportId, 'Ship it')
        assert.strictEqual(state, 'resolved')

        const result = await resultPromise
        assert.deepStrictEqual(result, { decision: 'Submit', value: 'Ship it', source: 'telegram' })
    })

    test('cancels pending ask_report sessions during reload cleanup', async () => {
        const reportId = `telegram-reload-${Date.now()}`
        const resultPromise = askReport({
            title: 'Telegram reload cleanup',
            markdown: 'This should be cancelled on reload',
            historyId: reportId,
        })

        const panel = getActiveAskReportPanel()
        assert.ok(panel, 'Expected ask_report panel to be active')

        const cancelled = cancelAllPendingAskReports('VS Code was reloaded before ask_report completed.')
        assert.strictEqual(cancelled >= 1, true)

        const result = await resultPromise
        assert.deepStrictEqual(result, {
            decision: 'Cancel',
            value: 'VS Code was reloaded before ask_report completed.',
            source: 'webview',
        })
    })
})