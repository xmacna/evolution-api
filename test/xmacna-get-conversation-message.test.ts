import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.S3_ENABLED = 'true';

const conversationMessage = import('../src/utils/getConversationMessage');

// MAR-304: the `media_unavailable` marker waits until the n8n missing-audio fallback
// covers the fleet; until then the webhook keeps the legacy `|undefined` format.
test('audio without mediaUrl keeps the legacy wire format', async () => {
  const { getConversationMessage } = await conversationMessage;
  const content = getConversationMessage({ key: { id: 'local-message' }, message: { audioMessage: {} } });
  assert.equal(content, 'audioMessage|undefined');
});

test('audio with mediaUrl preserves the existing wire format', async () => {
  const { getConversationMessage } = await conversationMessage;
  const content = getConversationMessage({
    key: { id: 'local-message' },
    message: { audioMessage: {}, mediaUrl: 'https://local.invalid/audio.ogg' },
  });
  assert.equal(content, 'audioMessage|https://local.invalid/audio.ogg');
});
