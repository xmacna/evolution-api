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

// xmacna/elysium#696: an unmapped message used to come back as the literal 'unknown' (the
// `messageType` metadata leaking as content) and the n8n bot answered it as if the lead typed it.
test('unmapped messages have no content instead of the literal unknown', async () => {
  const { getConversationMessage, hasConversationContent } = await conversationMessage;
  const unmapped = [
    { reactionMessage: { key: { id: 'BOT-MSG' }, text: '👍' } },
    { stickerMessage: { mimetype: 'image/webp' } },
    { pollUpdateMessage: { pollCreationMessageKey: { id: 'POLL' } } },
    {},
  ];
  for (const message of unmapped) {
    const content = getConversationMessage({ key: { id: 'local-message' }, message });
    assert.equal(content, undefined, JSON.stringify(Object.keys(message)));
    assert.equal(hasConversationContent(content), false);
  }
});

test('text, emoji typed as text and ad-only messages keep their content', async () => {
  const { getConversationMessage, hasConversationContent } = await conversationMessage;
  const cases: Array<[any, string]> = [
    [{ key: { id: 'a' }, message: { conversation: '👍' } }, '👍'],
    [{ key: { id: 'b' }, message: { extendedTextMessage: { text: 'ok, pode ser' } } }, 'ok, pode ser'],
    [{ key: { id: 'c' }, message: {}, contextInfo: { externalAdReply: { body: 'Anúncio' } } }, 'externalAdReplyBody|Anúncio'],
  ];
  for (const [msg, expected] of cases) {
    const content = getConversationMessage(msg);
    assert.equal(content, expected);
    assert.equal(hasConversationContent(content), true);
  }
});
