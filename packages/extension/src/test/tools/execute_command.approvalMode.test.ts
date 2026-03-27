import * as assert from 'assert';
import {
  getApprovalRoutingPlan,
  parseConfirmationMode,
  shouldRequestCommandConfirmation,
} from '../../tools/execute_command';

suite('execute_command approval mode helpers', () => {
  test('parseConfirmationMode normalizes supported values and defaults safely', () => {
    assert.strictEqual(parseConfirmationMode('telegram'), 'telegram');
    assert.strictEqual(parseConfirmationMode(' BOTH '), 'both');
    assert.strictEqual(parseConfirmationMode('auto'), 'auto');
    assert.strictEqual(parseConfirmationMode('unknown-value'), 'vscode');
    assert.strictEqual(parseConfirmationMode(undefined), 'vscode');
  });

  test('shouldRequestCommandConfirmation skips prompts only in auto mode or non-destructive opt-out', () => {
    assert.strictEqual(shouldRequestCommandConfirmation(true, false, 'vscode'), true);
    assert.strictEqual(shouldRequestCommandConfirmation(false, true, 'vscode'), true);
    assert.strictEqual(shouldRequestCommandConfirmation(false, false, 'vscode'), false);
    assert.strictEqual(shouldRequestCommandConfirmation(true, true, 'auto'), false);
  });

  test('getApprovalRoutingPlan falls back to VS Code when telegram-only mode is unavailable', () => {
    assert.deepStrictEqual(getApprovalRoutingPlan('vscode', false), {
      mode: 'vscode',
      useVscode: true,
      useTelegram: false,
    });

    assert.deepStrictEqual(getApprovalRoutingPlan('both', true), {
      mode: 'both',
      useVscode: true,
      useTelegram: true,
    });

    const telegramFallback = getApprovalRoutingPlan('telegram', false);
    assert.strictEqual(telegramFallback.mode, 'telegram');
    assert.strictEqual(telegramFallback.useVscode, true);
    assert.strictEqual(telegramFallback.useTelegram, false);
    assert.match(telegramFallback.warningMessage ?? '', /falling back to VS Code/i);

    const autoPlan = getApprovalRoutingPlan('auto', true);
    assert.deepStrictEqual(autoPlan, {
      mode: 'auto',
      useVscode: false,
      useTelegram: false,
    });
  });
});
