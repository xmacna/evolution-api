import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proto } from 'baileys';

import { ownKeyMediaMessage } from '../src/api/integrations/channel/whatsapp/inboundMediaUpload';
import { BaileysStartupService } from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';

// MAR-304: received media is a raw Baileys protobuf. getBase64FromMediaMessage skips it
// when `'messageContextInfo' in message` (true through the prototype) and it has a single
// own key. These tests feed decoded protobufs, as Baileys delivers them, to the real method.

const PAST_GUARD = 'PAST_MESSAGE_CONTEXT_GUARD';
const SKIPPED = 'verbose:Message contains only messageContextInfo, skipping media processing';
const key = { id: '3EB0LOCALTEST', remoteJid: '5500000000000@s.whatsapp.net', fromMe: false };
const bytes = () => new Uint8Array(32);
const audio = {
  url: 'https://mmg.whatsapp.net/local-test',
  mimetype: 'audio/ogg; codecs=opus',
  fileLength: 1024,
  seconds: 3,
  ptt: true,
  mediaKey: bytes(),
  directPath: '/local-test',
  fileSha256: bytes(),
  fileEncSha256: bytes(),
};
const document = { ...audio, mimetype: 'application/pdf', fileName: 'local.pdf', caption: 'local', ptt: undefined };
const contextInfo = { messageSecret: bytes() };

const decode = (message: object) =>
  proto.Message.decode(proto.Message.encode(proto.Message.fromObject(message)).finish());

// The first media-field read after the guard is `mediaMessage.mediaKey`; a throwing getter
// proves the method went past the guard without touching the network.
const armMediaKey = (media: object) =>
  Object.defineProperty(media, 'mediaKey', {
    get: () => {
      throw new Error(PAST_GUARD);
    },
  });

const getBase64 = async (message: object) => {
  const logs: string[] = [];
  const self = {
    logger: {
      verbose: (value: unknown) => logs.push(`verbose:${value}`),
      error: () => undefined,
      info: () => undefined,
    },
    client: { updateMediaMessage: async () => undefined },
    getMessage: async () => null,
    mapMediaType: async () => 'audio',
  };
  const outcome = await (BaileysStartupService.prototype as any).getBase64FromMediaMessage
    .call(self, { message }, true)
    .then((value: unknown) => (value === null ? 'skipped' : 'returned'))
    .catch((error: unknown) => (String((error as Error)?.message ?? error).includes(PAST_GUARD) ? 'past_guard' : 'threw'));
  return { outcome, logs };
};

test('wacli shape (only audioMessage) is dropped raw and reaches media processing as own-key copy', async () => {
  const message = decode({ audioMessage: audio });
  armMediaKey(message.audioMessage);
  const received = { key, message };

  const raw = await getBase64(received);
  assert.equal(raw.outcome, 'skipped');
  assert.deepEqual(raw.logs, [SKIPPED]);

  const own = await getBase64(ownKeyMediaMessage(received));
  assert.equal(own.outcome, 'past_guard');
  assert.deepEqual(own.logs, []);
});

test('phone shape (audioMessage + messageContextInfo) reaches media processing either way', async () => {
  const message = decode({ audioMessage: audio, messageContextInfo: contextInfo });
  armMediaKey(message.audioMessage);
  const received = { key, message };

  assert.equal((await getBase64(received)).outcome, 'past_guard');
  assert.equal((await getBase64(ownKeyMediaMessage(received))).outcome, 'past_guard');
});

test('messageContextInfo-only message is still skipped with the own-key copy', async () => {
  const received = { key, message: decode({ messageContextInfo: contextInfo }) };

  const own = await getBase64(ownKeyMediaMessage(received));
  assert.equal(own.outcome, 'skipped');
  assert.deepEqual(own.logs, [SKIPPED]);
});

test('document with caption: the unwrapped inner protobuf is dropped raw and kept as own-key copy', async () => {
  const message = decode({
    documentWithCaptionMessage: { message: { documentMessage: document } },
    messageContextInfo: contextInfo,
  });
  armMediaKey(message.documentWithCaptionMessage.message.documentMessage);

  assert.equal((await getBase64({ key, message })).outcome, 'skipped');
  assert.equal((await getBase64(ownKeyMediaMessage({ key, message }))).outcome, 'past_guard');
});

test('ephemeral wacli audio reaches media processing and the received message is not mutated', async () => {
  const message = decode({ ephemeralMessage: { message: { audioMessage: audio } } });
  armMediaKey(message.ephemeralMessage.message.audioMessage);
  const received = { key, message };

  assert.equal((await getBase64(ownKeyMediaMessage(received))).outcome, 'past_guard');
  assert.equal(received.message, message);
  assert.deepEqual(Object.keys(received.message), ['ephemeralMessage']);
  assert.ok(received.message.ephemeralMessage.message instanceof proto.Message);
});

test('send path shape (prepareMessage output) already passes the guard without the own-key copy', async () => {
  const sent = { key: { ...key, fromMe: true }, message: decode({ audioMessage: audio }), messageTimestamp: 1 };
  const service = BaileysStartupService.prototype as any;
  const self = { instanceId: 'local-instance', deserializeMessageBuffers: service.deserializeMessageBuffers };
  self.deserializeMessageBuffers = self.deserializeMessageBuffers.bind(self);
  const messageRaw = service.prepareMessage.call(self, sent);
  armMediaKey(messageRaw.message.audioMessage);

  assert.equal((await getBase64(messageRaw)).outcome, 'past_guard');
});
