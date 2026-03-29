import * as assert from 'assert'
import { DiffProvider, summarizeGitDiff } from '../../../integrations/telegram/diffProvider'

suite('DiffProvider', () => {
  test('summarizeGitDiff produces a compact mobile-friendly summary', () => {
    const summary = summarizeGitDiff(
      '2 files changed, 10 insertions(+), 3 deletions(-)',
      'src/feature.ts\nsrc/feature.test.ts',
    )

    assert.match(summary, /2 files changed/)
    assert.match(summary, /feature.ts/)
    assert.doesNotMatch(summary, /src\/feature.ts\nsrc\/feature.test.ts/)
  })

  test('captureLatestDiff reports unavailable when no workspace is associated', async () => {
    const provider = new DiffProvider()
    const snapshot = await provider.captureLatestDiff('session-1', null)

    assert.strictEqual(snapshot.status, 'unavailable')
    assert.strictEqual(snapshot.fullArtifactPath, null)
    assert.match(snapshot.summary, /no active workspace/i)
  })
})