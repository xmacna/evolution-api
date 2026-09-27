import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { buildChatbotDebounceKey, processChatbotDebounce } from '../src/api/integrations/chatbot/chatbotDebounce';
import { PrismaLidPhoneAliasStore, resolveInboundAddress } from '../src/api/integrations/channel/whatsapp/inboundIdentity';
import { inboundPayloadHash, normalizeContactScope, normalizeInstanceScope, PrismaInboundInbox } from '../src/api/integrations/channel/whatsapp/inboundInbox';
import { attemptDurableInboundSink } from '../src/api/integrations/channel/whatsapp/inboundSinkDispatch';
import { resetAmbiguousAlias } from '../src/cli/inboundInboxMaintenance';

const enabled = process.env.XMACNA_INBOX_INTEGRATION === '1';
const phone = '5511999999999@s.whatsapp.net';
const lid = '118837617901692@lid';

test('515/517/525: stable receipts, one phone session, 525 retained and LID reply destination after process restart', { skip: !enabled }, async () => {
  const firstProcess = new PrismaClient();
  const aliases = new PrismaLidPhoneAliasStore(firstProcess as any);
  const inbox = new PrismaInboundInbox(firstProcess as any);
  const suffix = randomUUID();
  const instanceName = `mar229-${suffix}`;
  const instanceId = `mar229-${suffix}`;
  const instanceScope = normalizeInstanceScope(instanceName);
  const sourceCluster = 'mar229-local';
  const deliveries = [
    { id: 'wamid-515', remoteJid: lid, remoteJidAlt: phone, content: '515' },
    { id: 'wamid-515', remoteJid: phone, remoteJidAlt: lid, content: '515' },
    { id: 'wamid-517', remoteJid: phone, remoteJidAlt: lid, content: '517' },
    { id: 'wamid-525', remoteJid: lid, remoteJidAlt: undefined, content: '525' },
  ];
  const sessions = new Set<string>();
  const dispatches: Array<{ id: string; phone: string; destination?: string; debounceKey: string }> = [];
  const debounceStore = {};
  const flushed: string[] = [];
  let lastFlush: Promise<void> | undefined;

  try {
    await firstProcess.$connect();
    await firstProcess.instance.create({ data: { id: instanceId, name: instanceName, inboundInboxMode: 'enforce' } });

    for (const [index, delivery] of deliveries.entries()) {
      // Recreate both the Prisma client and alias store before 525 to prove
      // the alias is in PostgreSQL, not in a module or socket cache.
      const process = index === 3 ? new PrismaClient() : firstProcess;
      if (index === 3) await process.$connect();
      try {
        const resolver = index === 3 ? new PrismaLidPhoneAliasStore(process as any) : aliases;
        const resolved = await resolveInboundAddress(instanceName, delivery, resolver, async () => null);
        const received = {
          key: { id: delivery.id, remoteJid: delivery.remoteJid, remoteJidAlt: delivery.remoteJidAlt, fromMe: false },
          message: { conversation: delivery.content },
        };
        const receipt = await inbox.claim({
          sourceCluster,
          instanceId,
          instanceScope,
          contactScope: normalizeContactScope(resolved.remoteJid),
          messageId: delivery.id,
          classification: 'real',
          payloadHash: inboundPayloadHash(received as any),
          leaseOwner: `worker-${index}`,
          messageData: {
            key: { ...received.key, senderLid: resolved.senderLid },
            message: received.message,
            messageType: 'conversation',
            messageTimestamp: index + 1,
            source: 'unknown',
            instanceId,
          },
        }, 'enforce');
        if (!receipt.shouldDispatch) continue;
        sessions.add(`bot_${resolved.remoteJid.split('@')[0]}`);
        const debounceKey = buildChatbotDebounceKey(instanceName, resolved.remoteJid);
        dispatches.push({ id: delivery.id, phone: resolved.remoteJid, destination: resolved.senderLid, debounceKey });
        lastFlush = processChatbotDebounce(
          debounceStore,
          delivery.content,
          debounceKey,
          1,
          async (content) => { flushed.push(content); },
        ).flushed;
      } finally {
        if (index === 3) await process.$disconnect();
      }
    }
    await lastFlush;
    assert.deepEqual(dispatches.map(({ id }) => id), ['wamid-515', 'wamid-517', 'wamid-525']);
    assert.equal(new Set(dispatches.map(({ debounceKey }) => debounceKey)).size, 1);
    assert.deepEqual([...sessions], ['bot_5511999999999']);
    assert.equal(dispatches.at(-1)?.destination, lid);
    assert.deepEqual(flushed, ['515\n517\n525']);
    assert.equal(await firstProcess.inboundReceipt.count({ where: { sourceCluster, instanceScope } }), 3);
  } finally {
    await firstProcess.inboundReceipt.deleteMany({ where: { sourceCluster, instanceScope } });
    await firstProcess.message.deleteMany({ where: { instanceId } });
    await firstProcess.lidPhoneAlias.deleteMany({ where: { instanceScope } });
    await firstProcess.instance.deleteMany({ where: { id: instanceId } });
    await firstProcess.$disconnect();
  }
});

test('concurrent conflicting confirmations poison an instance alias durably', { skip: !enabled }, async () => {
  const client = new PrismaClient();
  const scope = normalizeInstanceScope(`mar229-conflict-${randomUUID()}`);
  const store = new PrismaLidPhoneAliasStore(client as any);
  try {
    await client.$connect();
    const results = await Promise.allSettled([
      store.confirm(scope, lid, phone),
      store.confirm(scope, lid, '5511888888888@s.whatsapp.net'),
    ]);
    assert.equal(results.filter((result) => result.status === 'rejected').length >= 1, true);
    await assert.rejects(store.find(scope, lid), /ambiguous/);
    const row = await client.lidPhoneAlias.findUniqueOrThrow({
      where: { instanceScope_lidJid: { instanceScope: scope, lidJid: lid } },
    });
    assert.equal(row.ambiguous, true);
    assert.equal(row.phoneJid, null);
  } finally {
    await client.lidPhoneAlias.deleteMany({ where: { instanceScope: scope } });
    await client.$disconnect();
  }
});

test('unknown LID keeps human sinks and receipt, then replays chatbot after confirmation', { skip: !enabled }, async () => {
  const client = new PrismaClient();
  const instanceName = `mar229-unresolved-${randomUUID()}`;
  const instanceId = instanceName;
  const instanceScope = normalizeInstanceScope(instanceName);
  const sourceCluster = 'mar229-local';
  const inbox = new PrismaInboundInbox(client as any);
  const aliases = new PrismaLidPhoneAliasStore(client as any);
  const delivered: string[] = [];
  try {
    await client.$connect();
    await client.instance.create({ data: { id: instanceId, name: instanceName, inboundInboxMode: 'enforce' } });
    const first = { key: { id: 'wamid-unknown', remoteJid: lid, fromMe: false }, message: { conversation: 'first' } };
    const unresolved = await resolveInboundAddress(instanceName, first.key, aliases, async () => null).catch((error) => error);
    assert.match(unresolved.message, /unknown/);
    const claim = await inbox.claim({
      sourceCluster, instanceScope, instanceId, messageId: first.key.id,
      contactScope: normalizeContactScope(lid), classification: 'real', payloadHash: inboundPayloadHash(first as any),
      leaseOwner: 'first-worker', messageData: {
        key: first.key, message: first.message, messageType: 'conversation', messageTimestamp: 1,
        source: 'unknown', instanceId,
      },
    }, 'enforce');
    assert.equal(claim.shouldDispatch, true);
    const mark = (sink: 'webhook' | 'chatwoot' | 'chatbot', state: 'sent' | 'skipped' | 'failed') =>
      inbox.markSink(claim.receiptId, sink, state, 'first-worker', claim.leaseToken!).then((ok) => { assert.equal(ok, true); });
    for (const sink of ['chatwoot', 'webhook'] as const) {
      const failure = await attemptDurableInboundSink({ sink, operation: async () => { delivered.push(sink); return 'sent'; }, mark });
      assert.equal(failure, undefined);
    }
    const failed = await attemptDurableInboundSink({
      sink: 'chatbot', operation: async () => { throw unresolved; }, mark,
    });
    assert.equal(failed?.sink, 'chatbot');
    assert.deepEqual(delivered, ['chatwoot', 'webhook']);
    assert.equal(await inbox.markFailed(claim.receiptId, 'first-worker', claim.leaseToken!, failed?.error, 10, 0), true);

    // A second message in the same batch can still be claimed and delivered.
    const second = await inbox.claim({
      sourceCluster, instanceScope, instanceId, messageId: 'wamid-next',
      contactScope: normalizeContactScope(lid), classification: 'real', payloadHash: inboundPayloadHash({ message: { conversation: 'next' } } as any),
      leaseOwner: 'second-worker', messageData: {
        key: { id: 'wamid-next', remoteJid: lid, fromMe: false }, message: { conversation: 'next' },
        messageType: 'conversation', messageTimestamp: 2, source: 'unknown', instanceId,
      },
    }, 'enforce');
    assert.equal(second.shouldDispatch, true);
    for (const sink of ['chatwoot', 'webhook'] as const) {
      assert.equal(await inbox.markSink(second.receiptId, sink, 'sent', 'second-worker', second.leaseToken!), true);
    }
    assert.equal(await inbox.markSink(second.receiptId, 'chatbot', 'failed', 'second-worker', second.leaseToken!), true);
    assert.equal(await inbox.markFailed(second.receiptId, 'second-worker', second.leaseToken!, unresolved, 10, 0), true);

    await aliases.confirm(instanceScope, lid, phone);
    const replay = await inbox.leaseNext(sourceCluster, instanceScope, 'replay-worker', 30, 10);
    assert.equal(replay?.receiptId, claim.receiptId);
    assert.equal(replay?.chatwootState, 'sent');
    assert.equal(replay?.webhookState, 'sent');
    assert.equal(replay?.chatbotState, 'failed');
    const resolved = await resolveInboundAddress(instanceName, (replay!.message as any).key, aliases, async () => null);
    assert.deepEqual(resolved, { remoteJid: phone, senderLid: lid });
    assert.equal(await inbox.markSink(replay!.receiptId, 'chatbot', 'sent', 'replay-worker', replay!.leaseToken), true);
    assert.equal(await inbox.markDone(replay!.receiptId, 'replay-worker', replay!.leaseToken), true);
    const secondReplay = await inbox.leaseNext(sourceCluster, instanceScope, 'replay-worker', 30, 10);
    assert.equal(secondReplay?.receiptId, second.receiptId);
    assert.deepEqual(await resolveInboundAddress(instanceName, (secondReplay!.message as any).key, aliases), { remoteJid: phone, senderLid: lid });
    assert.equal(await inbox.markSink(secondReplay!.receiptId, 'chatbot', 'sent', 'replay-worker', secondReplay!.leaseToken), true);
    assert.equal(await inbox.markDone(secondReplay!.receiptId, 'replay-worker', secondReplay!.leaseToken), true);
    assert.equal(await client.inboundReceipt.count({ where: { sourceCluster, instanceScope, state: 'done' } }), 2);
  } finally {
    await client.inboundReceipt.deleteMany({ where: { sourceCluster, instanceScope } });
    await client.message.deleteMany({ where: { instanceId } });
    await client.lidPhoneAlias.deleteMany({ where: { instanceScope } });
    await client.instance.deleteMany({ where: { id: instanceId } });
    await client.$disconnect();
  }
});

test('ambiguous alias reset is dry-run by default and snapshots before local deletion', { skip: !enabled }, async () => {
  const client = new PrismaClient();
  const instanceName = `mar229-reset-${randomUUID()}`;
  const instanceScope = normalizeInstanceScope(instanceName);
  const folder = mkdtempSync(join(tmpdir(), 'mar229-alias-'));
  const snapshotOut = join(folder, 'alias.json');
  try {
    await client.$connect();
    await client.lidPhoneAlias.create({ data: { instanceScope, lidJid: lid, ambiguous: true } });
    const options = { command: 'alias-reset' as const, instanceName, lid, snapshotOut, batchSize: 1, live: false };
    await resetAmbiguousAlias(client, options);
    assert.equal((await client.lidPhoneAlias.findUnique({ where: { instanceScope_lidJid: { instanceScope, lidJid: lid } } }))?.ambiguous, true);
    await resetAmbiguousAlias(client, { ...options, live: true });
    assert.equal(await client.lidPhoneAlias.count({ where: { instanceScope, lidJid: lid } }), 0);
    assert.equal(JSON.parse(readFileSync(snapshotOut, 'utf8')).alias.lidJid, lid);
    assert.equal(statSync(snapshotOut).mode & 0o777, 0o600);
  } finally {
    await client.lidPhoneAlias.deleteMany({ where: { instanceScope } });
    await client.$disconnect();
    rmSync(folder, { recursive: true, force: true });
  }
});
