import * as assert from 'assert';
import {
  buildTelegramAskReportText,
  parseAskReportDeliveryMode,
  parseTelegramActionCallback,
  splitTelegramMessage,
} from '../../../integrations/telegram/messageBridge';

suite('Telegram message bridge helpers', () => {
  test('parseTelegramActionCallback recognizes approval and voice callbacks', () => {
    assert.deepStrictEqual(parseTelegramActionCallback('approval:approve:abc'), {
      type: 'approval-approve',
      approvalId: 'abc',
    });

    assert.deepStrictEqual(parseTelegramActionCallback('approval:deny:abc'), {
      type: 'approval-deny',
      approvalId: 'abc',
    });

    assert.deepStrictEqual(parseTelegramActionCallback('approval:deny:skip:abc'), {
      type: 'approval-deny-skip',
      approvalId: 'abc',
    });

    assert.deepStrictEqual(parseTelegramActionCallback('voice:confirm:req-1'), {
      type: 'voice-confirm',
      voiceRequestId: 'req-1',
    });

    assert.deepStrictEqual(parseTelegramActionCallback('voice:cancel:req-2'), {
      type: 'voice-cancel',
      voiceRequestId: 'req-2',
    });

    assert.strictEqual(parseTelegramActionCallback('unknown:callback'), undefined);
  });

  test('splitTelegramMessage preserves short messages untouched', () => {
    assert.deepStrictEqual(splitTelegramMessage('short message', 20), ['short message']);
  });

  test('parseAskReportDeliveryMode normalizes supported settings safely', () => {
    assert.strictEqual(parseAskReportDeliveryMode('message'), 'message');
    assert.strictEqual(parseAskReportDeliveryMode(' DOCUMENT '), 'document');
    assert.strictEqual(parseAskReportDeliveryMode(undefined), 'auto');
    assert.strictEqual(parseAskReportDeliveryMode('unexpected'), 'auto');
  });

  test('buildTelegramAskReportText truncates oversized messages safely', () => {
    const text = buildTelegramAskReportText('Topic', 'x'.repeat(200), 80);
    assert.ok(text.length <= 80, `Expected truncated text to fit the limit, got ${text.length}`);
    assert.match(text, /\[truncated for Telegram\]$/);
  });

  test('splitTelegramMessage breaks long content into bounded chunks', () => {
    const text = [
      'alpha alpha alpha',
      'beta beta beta',
      'gamma gamma gamma',
      'delta delta delta',
    ].join('\n');

    const chunks = splitTelegramMessage(text, 20);

    assert.ok(chunks.length > 1, 'Expected the message to be split into multiple chunks');
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 20, `Chunk exceeded limit: ${chunk.length}`);
    }

    const recombined = chunks.join('\n');
    assert.match(recombined, /alpha alpha alpha/);
    assert.match(recombined, /delta delta delta/);
  });
});
