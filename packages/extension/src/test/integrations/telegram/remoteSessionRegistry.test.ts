import * as assert from 'assert'
import { RemoteSessionRegistry } from '../../../integrations/telegram/remoteSessionRegistry'

suite('RemoteSessionRegistry', () => {
  test('registers and resolves ask_report items', () => {
    const registry = new RemoteSessionRegistry()

    const registration = registry.registerAskReport({
      reportId: 'report-1',
      topicName: 'Need input',
      message: 'Choose a deployment window',
      options: ['Now', 'Later'],
      sessionTitle: 'workspace · Need input',
      workspacePath: '/tmp/workspace',
    })

    assert.strictEqual(registration.binding.status, 'pending')
    assert.strictEqual(registration.item.status, 'pending')

    const resolved = registry.resolveAskReport('report-1', 'Submitted from Telegram ✓ Later')
    assert.ok(resolved)
    assert.strictEqual(resolved?.status, 'resolved')

    const binding = registry.getAskReportBinding('report-1')
    assert.strictEqual(binding?.status, 'resolved')
  })

  test('normalizes approval items into the shared inbox model', () => {
    const registry = new RemoteSessionRegistry()

    const registration = registry.registerApprovalRequest({
      approvalId: 'approval-1',
      command: 'pnpm package',
      destructive: false,
      sessionTitle: 'Command approval',
      workspacePath: '/tmp/workspace',
    })

    assert.strictEqual(registration.item.kind, 'approval')
    assert.strictEqual(registration.item.status, 'pending')

    const resolved = registry.resolveApproval('approval-1', 'Approved ✓')
    assert.ok(resolved)
    assert.strictEqual(resolved?.status, 'resolved')
  })

  test('selects recent sessions and exposes the next pending item', () => {
    const registry = new RemoteSessionRegistry()

    const first = registry.registerRemoteItem({
      kind: 'status',
      title: 'First task',
      summary: 'Initial remote task',
      status: 'informational',
      sessionTitle: 'workspace · First task',
      workspacePath: '/tmp/workspace',
    })

    const second = registry.registerAskReport({
      reportId: 'report-2',
      topicName: 'Second task',
      message: 'Need a decision',
      sessionTitle: 'workspace · Second task',
      workspacePath: '/tmp/workspace-2',
    })

    const activeSession = registry.getSelectedSession()
    assert.strictEqual(activeSession?.sessionId, second.session.sessionId)

    const recentSessions = registry.listRecentSessions(2)
    assert.strictEqual(recentSessions.length, 2)
    assert.deepStrictEqual(
      new Set(recentSessions.map((session) => session.sessionId)),
      new Set([first.session.sessionId, second.session.sessionId]),
    )

    registry.selectSession(first.session.sessionId)
    assert.strictEqual(registry.getSelectedSession()?.sessionId, first.session.sessionId)

    const pending = registry.getNextPendingItem(second.session.sessionId)
    assert.strictEqual(pending?.inboxItemId, second.item.inboxItemId)
  })

  test('records and returns the latest diff snapshot for a session', () => {
    const registry = new RemoteSessionRegistry()

    const session = registry.registerRemoteItem({
      kind: 'status',
      title: 'Diff task',
      summary: 'Ready for diff capture',
      status: 'informational',
      sessionTitle: 'workspace · Diff task',
      workspacePath: '/tmp/workspace',
    }).session

    registry.recordDiffSnapshot({
      sessionId: session.sessionId,
      sessionTitle: session.title,
      workspacePath: session.workspacePath,
      snapshot: {
        diffId: 'diff-1',
        sessionId: session.sessionId,
        source: 'git-worktree',
        summary: '2 files changed',
        fullArtifactPath: '/tmp/workspace/diff.patch',
        fingerprint: 'fingerprint-1',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        status: 'ready',
      },
    })

    const snapshot = registry.getLatestDiffSnapshot(session.sessionId)
    assert.strictEqual(snapshot?.diffId, 'diff-1')
    assert.strictEqual(snapshot?.summary, '2 files changed')

    const updated = registry.updateDiffSnapshotStatus(session.sessionId, 'stale', 'Artifact delivery failed')
    assert.strictEqual(updated?.status, 'stale')
    assert.strictEqual(updated?.summary, 'Artifact delivery failed')
  })

  test('supersedes prior diff summary items when a newer snapshot is recorded', () => {
    const registry = new RemoteSessionRegistry()

    const session = registry.registerRemoteItem({
      kind: 'status',
      title: 'Diff supersede task',
      summary: 'Tracking diff state',
      status: 'informational',
      sessionTitle: 'workspace · Diff supersede task',
      workspacePath: '/tmp/workspace',
    }).session

    registry.recordDiffSnapshot({
      sessionId: session.sessionId,
      sessionTitle: session.title,
      workspacePath: session.workspacePath,
      snapshot: {
        diffId: 'diff-1',
        sessionId: session.sessionId,
        source: 'git-worktree',
        summary: 'First diff',
        fullArtifactPath: '/tmp/workspace/first.patch',
        fingerprint: 'fingerprint-1',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        status: 'ready',
      },
    })

    registry.recordDiffSnapshot({
      sessionId: session.sessionId,
      sessionTitle: session.title,
      workspacePath: session.workspacePath,
      snapshot: {
        diffId: 'diff-2',
        sessionId: session.sessionId,
        source: 'git-worktree',
        summary: 'Second diff',
        fullArtifactPath: '/tmp/workspace/second.patch',
        fingerprint: 'fingerprint-2',
        createdAt: new Date('2025-01-01T00:01:00.000Z'),
        status: 'ready',
      },
    })

    const diffItems = registry
      .listRecentInboxItems({ sessionId: session.sessionId, limit: 10 })
      .filter((item) => item.kind === 'diff-summary')

    assert.strictEqual(diffItems.length, 2)
    const statuses = diffItems.map((item) => item.status).sort()

    assert.deepStrictEqual(statuses, ['informational', 'superseded'])
    assert.ok(diffItems.some((item) => item.summary === 'Second diff'))
    assert.ok(diffItems.some((item) => item.summary === 'Superseded by a newer diff snapshot.'))
  })

  test('stores notification mode and returns filtered catch-up items', () => {
    const registry = new RemoteSessionRegistry()
    registry.setNotificationMode('all')

    const session = registry.registerRemoteItem({
      kind: 'status',
      title: 'Catch-up task',
      summary: 'Informational update',
      status: 'informational',
      sessionTitle: 'workspace · Catch-up task',
      workspacePath: '/tmp/workspace',
    }).session

    registry.registerApprovalRequest({
      approvalId: 'approval-2',
      command: 'pnpm lint',
      destructive: false,
      sessionTitle: session.title,
      workspacePath: session.workspacePath,
    })

    assert.strictEqual(registry.getNotificationMode(), 'all')

    const allItems = registry.listRecentInboxItems({ sessionId: session.sessionId, limit: 5 })
    const actionableItems = registry.listRecentInboxItems({ sessionId: session.sessionId, limit: 5, actionableOnly: true })

    assert.ok(allItems.length >= 2)
    assert.strictEqual(actionableItems.length, 1)
    assert.strictEqual(actionableItems[0].status, 'pending')
  })
})