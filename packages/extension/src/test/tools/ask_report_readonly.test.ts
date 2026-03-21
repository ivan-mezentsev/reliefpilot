import * as assert from 'assert'
import { askReport, getActiveAskReportPanel } from '../../tools/ask_report'

suite('Ask Report read-only mode', function () {
    this.timeout(10000)

    test('does not render or initialize voice input', async () => {
        const resultPromise = askReport({
            title: 'Ask Report Read-only Test',
            markdown: 'Read-only body',
            readOnly: true,
        })

        const panel = getActiveAskReportPanel()
        assert.ok(panel, 'Expected ask_report panel to be active')

        const html = panel!.webview.html
        assert.ok(!html.includes('id="micBtn"'), 'Read-only HTML should not render mic button')
        assert.ok(!html.includes('voice-input.js'), 'Read-only HTML should not load voice input script')
        assert.ok(!html.includes('initVoiceInput('), 'Read-only HTML should not initialize voice input')

        panel!.dispose()

        const result = await resultPromise
        assert.deepStrictEqual(result, { decision: 'Cancel', value: '' })
    })
})