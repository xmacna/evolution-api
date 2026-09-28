import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.S3_ENABLED = 'true';

const conversationMessage = import('../src/utils/getConversationMessage');

test('audio without mediaUrl carries an explicit unavailable marker', async () => {
  const { getConversationMessage } = await conversationMessage;
  const content = getConversationMessage({ key: { id: 'local-message' }, message: { audioMessage: {} } });
  assert.equal(content, 'audioMessage|media_unavailable');
  assert.equal(content.includes('|undefined'), false);
});

test('audio with mediaUrl preserves the existing wire format', async () => {
  const { getConversationMessage } = await conversationMessage;
  const content = getConversationMessage({
    key: { id: 'local-message' },
    message: { audioMessage: {}, mediaUrl: 'https://local.invalid/audio.ogg' },
  });
  assert.equal(content, 'audioMessage|https://local.invalid/audio.ogg');
});
