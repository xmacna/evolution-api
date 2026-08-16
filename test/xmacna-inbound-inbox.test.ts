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

test('canonical hash ignores Baileys device metadata added to a real-message replay', () => {
  const first = {
    key: { id: 'same-id' },
    message: {
      conversation: 'mesmo conteúdo',
      messageContextInfo: { messageSecret: 'stable', threadId: 'thread-1' },
    },
  };
  const enrichedReplay = {
    key: { id: 'same-id' },
    message: {
      conversation: 'mesmo conteúdo',
      messageContextInfo: {
        deviceListMetadata: { senderKeyHash: 'volatile' },
        deviceListMetadataVersion: 2,
        messageSecret: 'stable',
        threadId: 'thread-1',
      },
    },
  };

  assert.equal(inboundPayloadHash(first as any), inboundPayloadHash(enrichedReplay as any));
});

test('canonical hash preserves material message context while ignoring device metadata', () => {
  const base = {
    key: { id: 'same-id' },
    message: {
      extendedTextMessage: {
        text: 'resposta',
        contextInfo: { stanzaId: 'quoted-a', deviceListMetadataVersion: 1 },
      },
    },
  };
  const divergentQuote = {
    key: { id: 'same-id' },
    message: {
      extendedTextMessage: {
        text: 'resposta',
        contextInfo: { stanzaId: 'quoted-b', deviceListMetadataVersion: 2 },
      },
    },
  };

  assert.notEqual(inboundPayloadHash(base as any), inboundPayloadHash(divergentQuote as any));
});

test('receipt policy uses the stable provider id and tolerates enriched replay envelopes', () => {
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
  assert.equal(evaluateExistingReceipt(exact, { classification: 'real', payloadHash: 'b' }), 'duplicate');
});

test('CTWA referral enrichment changes the diagnostic hash without changing receipt identity', () => {
  const original = {
    key: { id: 'ctwa-provider-id', remoteJid: 'lead@s.whatsapp.net', fromMe: false },
    message: {
      extendedTextMessage: {
        text: 'Quero informações',
        contextInfo: { externalAdReply: { title: 'Campanha', sourceType: 'ad' } },
      },
    },
  };
  const enriched = {
    ...original,
    message: {
      extendedTextMessage: {
        text: 'Quero informações',
        contextInfo: {
          externalAdReply: { title: 'Campanha', sourceType: 'ad', mediaType: 2, thumbnailUrl: 'https://cdn.invalid/ad' },
        },
      },
    },
  };
  const originalHash = inboundPayloadHash(original as any);
  const enrichedHash = inboundPayloadHash(enriched as any);

  assert.notEqual(originalHash, enrichedHash);
  assert.equal(
    evaluateExistingReceipt(
      { id: 'receipt', classification: 'real', payloadHash: originalHash },
      { classification: 'real', payloadHash: enrichedHash },
    ),
    'duplicate',
  );
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
