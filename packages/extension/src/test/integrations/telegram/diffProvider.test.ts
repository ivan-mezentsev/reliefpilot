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
    assert.match(summary, /Impact: Source code and tests changed together/i)
    assert.doesNotMatch(summary, /src\/feature.ts\nsrc\/feature.test.ts/)
  })

  test('summarizeGitDiff explains documentation-only changes clearly', () => {
    const summary = summarizeGitDiff(
      '1 file changed, 8 insertions(+)',
      'docs/telegram.md',
    )

    assert.match(summary, /Impact: Documentation-focused changes/i)
  })

  test('captureLatestDiff reports unavailable when no workspace is associated', async () => {
    const provider = new DiffProvider()
    const snapshot = await provider.captureLatestDiff('session-1', null)

    assert.strictEqual(snapshot.status, 'unavailable')
    assert.strictEqual(snapshot.fullArtifactPath, null)
    assert.match(snapshot.summary, /no active workspace/i)
  })
})