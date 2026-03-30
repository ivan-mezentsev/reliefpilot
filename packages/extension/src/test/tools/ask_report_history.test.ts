import * as assert from 'assert'
import * as vscode from 'vscode'
import { askReportHistory } from '../../utils/ask_report_history'

suite('Ask Report History ring buffer', function () {
    this.timeout(10000)

    let originalMax: number | undefined

    suiteSetup(async () => {
        const cfg = vscode.workspace.getConfiguration('reliefpilot')
        originalMax = cfg.get<number>('askReportHistoryMaxEntries')
        await cfg.update('askReportHistoryMaxEntries', 3, vscode.ConfigurationTarget.Global)
    })

    suiteTeardown(async () => {
        const cfg = vscode.workspace.getConfiguration('reliefpilot')
        await cfg.update('askReportHistoryMaxEntries', originalMax ?? 20, vscode.ConfigurationTarget.Global)
    })

    test('Keeps only last N entries (most recent first)', async () => {
        // Insert five entries; limit is 3
        for (let i = 1; i <= 5; i++) {
            askReportHistory.add({ topic: `T${i}`, markdown: `M${i}` })
        }
        const items = askReportHistory.list()
        assert.strictEqual(items.length, 3)
        // Expect T5, T4, T3
        assert.deepStrictEqual(items.map((e) => e.topic), ['T5', 'T4', 'T3'])
    })

    test('Marks incomplete entries as cancelled after reload recovery', async () => {
        const pending = askReportHistory.add({ topic: 'Pending', markdown: 'Still running' })
        const settled = askReportHistory.add({
            topic: 'Settled',
            markdown: 'Already done',
            result: { decision: 'Submit', value: 'Done' },
        })

        const updated = askReportHistory.markIncompleteEntriesCancelled('Reloaded before completion')

        assert.strictEqual(updated >= 1, true)
        assert.deepStrictEqual(askReportHistory.getById(pending.id)?.result, {
            decision: 'Cancel',
            value: 'Reloaded before completion',
        })
        assert.deepStrictEqual(askReportHistory.getById(settled.id)?.result, {
            decision: 'Submit',
            value: 'Done',
        })
    })
})
