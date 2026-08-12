import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyInboundMessage,
  evaluateExistingReceipt,
  inboundPayloadHash,
  normalizeInstanceScope,
  resolveInboundMode,
} from '../src/api/integrations/channel/whatsapp/inboundInbox';

test('normalizes stable instance scope independently from internal instance ids', () => {
  assert.equal(normalizeInstanceScope('  FÁBI   FontesEnergia  '), 'fábi-fontesenergia');
});

test('classifies real, stub, protocol and internal control payloads', () => {
  assert.equal(classifyInboundMessage({ key: { id: '1' }, message: { conversation: 'oi' } } as any), 'real');
  assert.equal(classifyInboundMessage({ key: { id: '2' }, messageStubType: 2 } as any), 'stub');
  assert.equal(
    classifyInboundMessage({ key: { id: '3' }, message: { protocolMessage: { type: 1 } } } as any),
    'protocol',
  );
  assert.equal(
    classifyInboundMessage({ key: { id: '4' }, message: { conversation: 'requestPlaceholder' } } as any),
    'control',
  );
});

test('canonical hash ignores volatile timestamp, jid, fromMe and requestId fields', () => {
  const first = {
    key: { id: 'same-id', remoteJid: '551199@s.whatsapp.net', fromMe: false },
    messageTimestamp: 100,
    requestId: 'one',
    message: { conversation: 'conteúdo estável' },
  };
  const replay = {
    key: { id: 'same-id', remoteJid: '999999@lid', fromMe: true },
    messageTimestamp: 999,
    requestId: 'two',
    message: { conversation: 'conteúdo estável' },
  };
  assert.equal(inboundPayloadHash(first as any), inboundPayloadHash(replay as any));
});

test('canonical hash detects divergent real content', () => {
  const base = { key: { id: 'same-id' }, message: { conversation: 'A' } };
  const divergent = { key: { id: 'same-id' }, message: { conversation: 'B' } };
  assert.notEqual(inboundPayloadHash(base as any), inboundPayloadHash(divergent as any));
});

test('receipt policy deduplicates exact replay, promotes stub and quarantines collision', () => {
  const exact = { id: 'r1', classification: 'real', payloadHash: 'a' };
  assert.equal(evaluateExistingReceipt(exact, { classification: 'real', payloadHash: 'a' }), 'duplicate');
  assert.equal(
    evaluateExistingReceipt({ ...exact, classification: 'stub' }, { classification: 'real', payloadHash: 'b' }),
    'promoted',
  );
  assert.equal(evaluateExistingReceipt(exact, { classification: 'real', payloadHash: 'b' }), 'collision');
});

test('invalid persisted modes fail closed to the configured fallback', () => {
  assert.equal(resolveInboundMode('enforce', 'off'), 'enforce');
  assert.equal(resolveInboundMode('invalid', 'shadow'), 'shadow');
  assert.equal(resolveInboundMode(undefined, 'off'), 'off');
});
