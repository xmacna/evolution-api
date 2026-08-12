const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('pins the audited Baileys and CommonJS bridge versions', () => {
  const baileysPackage = readJson('node_modules/baileys/package.json');
  const bridgePackage = readJson('node_modules/whatsapp-rust-bridge/package.json');

  assert.equal(baileysPackage.version, '7.0.0-rc14');
  assert.equal(bridgePackage.version, '0.5.5');

  const baileys = require('baileys');
  const bridge = require('whatsapp-rust-bridge');
  assert.equal(typeof baileys.makeWASocket, 'function');
  assert.equal(typeof baileys.BufferJSON, 'object');
  assert.ok(baileys.WAProto?.Message);
  assert.ok(Object.keys(bridge).length > 0);
});

test('round-trips typed auth material with BufferJSON', () => {
  const { BufferJSON } = require('baileys');
  const encoded = JSON.stringify({ key: Uint8Array.from([0, 1, 127, 255]) }, BufferJSON.replacer);
  const decoded = JSON.parse(encoded, BufferJSON.reviver);

  assert.deepEqual(Array.from(decoded.key), [0, 1, 127, 255]);
});

test('contains the upstream CTWA placeholder recovery path', () => {
  const source = read('node_modules/baileys/lib/Socket/messages-recv.js');

  assert.match(source, /NO_MESSAGE_FOUND_ERROR_TEXT/);
  assert.match(source, /requestPlaceholderResend\(cleanKey, msgData\)/);
  assert.match(source, /fall through to upsertMessage so the stub is emitted/);
  assert.match(source, /messageStubParameters: \[NO_MESSAGE_FOUND_ERROR_TEXT, requestId\]/);
});

test('contains the GHSA self-only protocol guard without blocking legitimate cross-user events', () => {
  const source = read('node_modules/baileys/lib/Utils/process-message.js');
  const guardStart = source.indexOf('const SELF_ONLY_TYPES = new Set([');
  const switchStart = source.indexOf('switch (protocolMsg.type)', guardStart);
  assert.ok(guardStart >= 0 && switchStart > guardStart, 'protocol guard not found');

  const guard = source.slice(guardStart, switchStart);
  for (const type of [
    'HISTORY_SYNC_NOTIFICATION',
    'APP_STATE_SYNC_KEY_SHARE',
    'LID_MIGRATION_MAPPING_SYNC',
    'PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE',
  ]) {
    assert.match(guard, new RegExp(`ProtocolMessage\\.Type\\.${type}`));
  }
  for (const type of ['REVOKE', 'MESSAGE_EDIT', 'EPHEMERAL_SETTING', 'GROUP_MEMBER_LABEL_CHANGE']) {
    assert.doesNotMatch(guard, new RegExp(`ProtocolMessage\\.Type\\.${type}[,\\n]`));
    assert.match(source.slice(switchStart), new RegExp(`case proto\\.Message\\.ProtocolMessage\\.Type\\.${type}:`));
  }
  assert.match(guard, /SELF_ONLY_TYPES\.has\(protocolMsg\.type\)[\s\S]*!message\.key\.fromMe/);
});

test('contains the upstream privacy-token send, persistence, and recovery paths', () => {
  const send = read('node_modules/baileys/lib/Socket/messages-send.js');
  const receive = read('node_modules/baileys/lib/Socket/messages-recv.js');

  assert.match(send, /authState\.keys\.get\('tctoken'/);
  assert.match(send, /issuePrivacyTokens/);
  assert.match(send, /authState\.keys\.set\(\{\s*tctoken:/);
  assert.match(receive, /case 'privacy_token':/);
  assert.match(receive, /pruned expired tctokens/);
});

test('Evolution skips rc14 CIPHERTEXT placeholders before any sink effect', () => {
  const source = read('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');
  const handlerStart = source.indexOf("'messages.upsert': async (");
  const handlerEnd = source.indexOf("'messages.update': async", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'messages.upsert handler not found');

  const handler = source.slice(handlerStart, handlerEnd);
  const stubGuard = handler.indexOf("'Message absent from node'");
  const firstSink = Math.min(
    ...['chatwootService.eventWhatsapp', 'sendDataWebhook', 'prismaRepository.message.create']
      .map((needle) => handler.indexOf(needle))
      .filter((index) => index >= 0),
  );

  assert.ok(stubGuard >= 0, 'placeholder guard not found');
  assert.ok(firstSink > stubGuard, 'a sink effect can run before the placeholder guard');
  assert.match(handler.slice(stubGuard, firstSink), /continue;/);
});

test('all auth-state providers persist arbitrary rc14 key categories', () => {
  for (const file of [
    'src/utils/use-multi-file-auth-state-prisma.ts',
    'src/utils/use-multi-file-auth-state-redis-db.ts',
  ]) {
    const source = read(file);
    assert.match(source, /for \(const category in data\)/);
    assert.match(source, /`\$\{category\}-\$\{id\}`/);
  }
});
