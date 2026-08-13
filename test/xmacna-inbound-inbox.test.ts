import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from 'jsonschema';

import {
  canTransitionInboundMode,
  classifyInboundMessage,
  evaluateExistingReceipt,
  inboundPayloadHash,
  normalizeContactScope,
  normalizeInstanceScope,
  resolveInboundMode,
} from '../src/api/integrations/channel/whatsapp/inboundInbox';
import { inboundInboxModeSchema, instanceSchema } from '../src/validate/instance.schema';

test('derives stable tenant scopes without merging distinct raw instance names', () => {
  assert.equal(normalizeInstanceScope('Fabi'), normalizeInstanceScope('Fabi'));
  assert.notEqual(normalizeInstanceScope('Foo'), normalizeInstanceScope('foo'));
  assert.notEqual(normalizeInstanceScope('A B'), normalizeInstanceScope('A-B'));
  assert.match(normalizeInstanceScope('  FÁBI   FontesEnergia  '), /^v1:[0-9a-f]{64}$/);
  assert.equal(normalizeContactScope(' 5511999999999@S.WHATSAPP.NET '), '5511999999999@s.whatsapp.net');
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

test('receipt policy deduplicates exact replay, promotes every non-real class and quarantines real collision', () => {
  const exact = { id: 'r1', classification: 'real', payloadHash: 'a' };
  assert.equal(evaluateExistingReceipt(exact, { classification: 'real', payloadHash: 'a' }), 'duplicate');
  assert.equal(
    evaluateExistingReceipt({ ...exact, classification: 'stub' }, { classification: 'real', payloadHash: 'b' }),
    'promoted',
  );
  assert.equal(
    evaluateExistingReceipt({ ...exact, classification: 'control' }, { classification: 'real', payloadHash: 'b' }),
    'promoted',
  );
  assert.equal(
    evaluateExistingReceipt({ ...exact, classification: 'protocol' }, { classification: 'real', payloadHash: 'b' }),
    'promoted',
  );
  assert.equal(
    evaluateExistingReceipt(exact, { classification: 'protocol', payloadHash: 'b' }),
    'duplicate',
  );
  assert.equal(evaluateExistingReceipt(exact, { classification: 'real', payloadHash: 'b' }), 'collision');
});

test('invalid persisted modes never enable global enforce', () => {
  assert.equal(resolveInboundMode('enforce', 'off'), 'enforce');
  assert.equal(resolveInboundMode('invalid', 'shadow'), 'shadow');
  assert.equal(resolveInboundMode(undefined, 'enforce'), 'off');
  assert.equal(resolveInboundMode(undefined, 'off'), 'off');
});

test('enforce downgrade is blocked until incomplete receipts drain', () => {
  assert.equal(canTransitionInboundMode('enforce', 'off', 1), false);
  assert.equal(canTransitionInboundMode('enforce', 'shadow', 1), false);
  assert.equal(canTransitionInboundMode('enforce', 'off', 0), true);
  assert.equal(canTransitionInboundMode('shadow', 'off', 10), true);
});

test('instance API schemas accept only explicit inbox rollout modes', () => {
  assert.equal(validate({ instanceName: 'pilot', inboundInboxMode: 'shadow' }, instanceSchema).valid, true);
  assert.equal(validate({ instanceName: 'pilot', inboundInboxMode: 'unsafe' }, instanceSchema).valid, false);
  assert.equal(validate({ mode: 'enforce' }, inboundInboxModeSchema).valid, true);
  assert.equal(validate({ mode: 'unsafe' }, inboundInboxModeSchema).valid, false);
});
