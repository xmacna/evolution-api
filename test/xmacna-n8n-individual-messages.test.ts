import assert from 'node:assert/strict';
import test from 'node:test';

import { processChatbotDebounce, ChatbotDebounceStore } from '../src/api/integrations/chatbot/chatbotDebounce';
import {
  captureIndividualChatbotMessage,
  prepareN8nIndividualMessages,
} from '../src/api/integrations/chatbot/n8n/n8nIndividualMessages';

const event = (id: string, time: unknown, message: any, fromMe = false) => ({
  key: { id, remoteJid: 'lead@lid', participant: 'sender@lid', fromMe }, messageTimestamp: time, message,
});

test('debounce delivers every provider ID, content and timestamp in arrival order, with isolated snapshots', async () => {
  const store: ChatbotDebounceStore = {};
  let payload: any;
  const deliver = async (_: string, metadata: any) => {
    payload = await prepareN8nIndividualMessages(metadata.individualMessages, async () => { throw Error('not audio'); });
  };
  const firstEvent = captureIndividualChatbotMessage(event('first', '1792788000', { conversation: 'one' }), 'one');
  const first = processChatbotDebounce(store, 'one', 'key', 0.01, deliver, {
    messageTimestamp: firstEvent.messageTimestamp, individualMessage: firstEvent,
  });
  firstEvent.chatInput = 'caller mutation';
  first.metadata.individualMessages![0].chatInput = 'receipt mutation';
  const secondEvent = captureIndividualChatbotMessage(event('second', { toNumber: () => 1792788007 }, { conversation: 'two' }), 'two');
  const second = processChatbotDebounce(store, 'two', 'key', 0.01, deliver, {
    messageTimestamp: secondEvent.messageTimestamp, individualMessage: secondEvent,
  });
  assert.equal(first.metadata.messageCount, 1);
  assert.equal(first.metadata.individualMessages!.length, 1);
  await second.flushed;
  assert.deepEqual(payload.map((m: any) => [m.keyId, m.chatInput, m.providerTimestamp, m.fromMe, m.remoteJid, m.participant]), [
    ['first', 'one', 1792788000000, false, 'lead@lid', 'sender@lid'],
    ['second', 'two', 1792788007000, false, 'lead@lid', 'sender@lid'],
  ]);
});

test('two audios retain their own source, transcription and time around a text, without raw media keys in the payload', async () => {
  const first = event('audio-a', 1792788000, { audioMessage: { mediaKey: new Uint8Array([1, 2]) }, mediaUrl: 'https://local.invalid/a.ogg' });
  const second = event('audio-b', 1792788003, { audioMessage: {}, base64: 'private-audio-base64' });
  const captured = [captureIndividualChatbotMessage(first, 'audioMessage|a'),
    captureIndividualChatbotMessage(event('text', 1792788002, { conversation: 'middle' }), 'middle'),
    captureIndividualChatbotMessage(second, 'audioMessage|b')];
  first.message.mediaUrl = 'caller mutation';
  const ids: unknown[] = [];
  const result = await prepareN8nIndividualMessages(captured, async (source) => {
    ids.push(source!.key.id);
    if (source!.key.id === 'audio-a') assert.equal((source!.message as any).mediaUrl, 'https://local.invalid/a.ogg');
    return source!.key.id === 'audio-a' ? 'first audio' : 'second audio';
  });
  assert.deepEqual(ids, ['audio-a', 'audio-b']);
  assert.deepEqual(result.map(m => [m.keyId, m.chatInput, m.transcriptionStatus]), [
    ['audio-a', '[audio] first audio', 'available'], ['text', 'middle', undefined],
    ['audio-b', '[audio] second audio', 'available'],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /mediaKey|audioSource|private-audio-base64/);
});

test('audio failure retains its own event and marks it unavailable without copying the next transcription', async () => {
  const result = await prepareN8nIndividualMessages(['bad', 'good'].map((id, n) =>
    captureIndividualChatbotMessage(event(id, 1792788000 + n, { audioMessage: {} }), `audioMessage|${id}`)),
  async source => { if (source!.key.id === 'bad') throw Error('Whisper unavailable'); return 'actual text'; });
  assert.equal(result[0].keyId, 'bad');
  assert.equal(result[0].chatInput, 'audioMessage|bad');
  assert.equal(result[0].transcriptionStatus, 'unavailable');
  assert.equal(result[1].chatInput, '[audio] actual text');
});

test('already transcribed audio does not request transcription again', async () => {
  const result = await prepareN8nIndividualMessages([
    captureIndividualChatbotMessage(event('audio', 1792788000, { audioMessage: {}, speechToText: 'existing text' }), 'existing text'),
  ], async () => { throw Error('must not call'); });
  assert.equal(result[0].chatInput, 'existing text');
  assert.equal(result[0].transcriptionStatus, 'available');
});

test('missing, invalid or unsafe provider timestamps never become the current time', async () => {
  for (const time of [undefined, 'bad', Infinity, -1, 0, Number.MAX_SAFE_INTEGER]) {
    const result = await prepareN8nIndividualMessages([
      captureIndividualChatbotMessage(event('id', time, { conversation: 'text' }, true), 'text'),
    ], async () => null);
    assert.equal(result[0].providerTimestamp, undefined);
    assert.equal(result[0].fromMe, true);
  }
  const noIdentity = await prepareN8nIndividualMessages([captureIndividualChatbotMessage({}, 'text')], async () => null);
  assert.equal(noIdentity[0].keyId, undefined);
  assert.equal(noIdentity[0].providerTimestamp, undefined);
});
