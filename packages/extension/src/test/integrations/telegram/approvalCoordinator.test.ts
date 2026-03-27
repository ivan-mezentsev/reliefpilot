import * as assert from 'assert';
import { ApprovalCoordinator } from '../../../integrations/telegram/approvalCoordinator';

suite('ApprovalCoordinator', () => {
  let coordinator: ApprovalCoordinator;

  setup(() => {
    coordinator = new ApprovalCoordinator();
  });

  teardown(() => {
    coordinator.dispose();
  });

  test('applies telegram approval to attached VS Code session and resolves once', async () => {
    const request = coordinator.createRequest({
      command: 'rm -rf tmp',
      destructive: true,
      customCwd: '/tmp',
    });

    let forwardedResolution:
      | {
        approved: boolean;
        updatedCommand: string | null;
        feedback: string | null;
        source: 'vscode' | 'telegram';
      }
      | undefined;

    const attached = coordinator.attachVscodeSession(request.approvalId, {
      applyExternalResolution: (resolution) => {
        forwardedResolution = resolution;
      },
    });

    assert.strictEqual(attached, true);
    coordinator.registerTelegramMessage(request.approvalId, 42, 99);

    const first = coordinator.resolve(request.approvalId, {
      approved: true,
      updatedCommand: 'rm -rf tmp --force',
      feedback: null,
      source: 'telegram',
    });

    const second = coordinator.resolve(request.approvalId, {
      approved: false,
      feedback: 'too late',
      source: 'vscode',
    });

    const resolution = await coordinator.waitForResolution(request.approvalId);

    assert.strictEqual(first.state, 'resolved');
    assert.strictEqual(second.state, 'already-resolved');
    assert.strictEqual(resolution.approved, true);
    assert.strictEqual(resolution.updatedCommand, 'rm -rf tmp --force');
    assert.deepStrictEqual(forwardedResolution, resolution);

    const storedRequest = coordinator.getRequest(request.approvalId);
    assert.ok(storedRequest);
    assert.strictEqual(storedRequest?.status, 'approved');
    assert.strictEqual(storedRequest?.command, 'rm -rf tmp --force');
    assert.strictEqual(storedRequest?.telegramMessages.length, 1);
  });

  test('tracks denial feedback workflow for telegram users', () => {
    const request = coordinator.createRequest({
      command: 'git push',
      destructive: true,
    });

    const pending = coordinator.beginTelegramDenialFeedback(request.approvalId, 7, 700);
    assert.strictEqual(pending.state, 'resolved');
    assert.ok(coordinator.getPendingDenialFeedback(7));

    const result = coordinator.resolveTelegramDenialFeedback(7, 'wrong branch');
    assert.strictEqual(result.state, 'resolved');
    assert.strictEqual(result.resolution?.approved, false);
    assert.strictEqual(result.resolution?.feedback, 'wrong branch');
    assert.strictEqual(result.resolution?.source, 'telegram');
    assert.strictEqual(coordinator.getPendingDenialFeedback(7), undefined);
  });

  test('replays prior telegram resolution when VS Code session attaches late', () => {
    const request = coordinator.createRequest({
      command: 'npm publish',
      destructive: true,
    });

    coordinator.resolve(request.approvalId, {
      approved: false,
      feedback: 'hold release',
      source: 'telegram',
    });

    let replayedResolution: string | undefined;
    const attached = coordinator.attachVscodeSession(request.approvalId, {
      applyExternalResolution: (resolution) => {
        replayedResolution = `${resolution.source}:${resolution.feedback}`;
      },
    });

    assert.strictEqual(attached, true);
    assert.strictEqual(replayedResolution, 'telegram:hold release');
  });
});
