import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

import {
  InboundModeTransitionBlockedError,
  normalizeInstanceScope,
  PrismaInboundInbox,
  transitionInboundMode,
} from '../src/api/integrations/channel/whatsapp/inboundInbox';
import { backfill, exportTombstones, importTombstones } from '../src/cli/inboundInboxMaintenance';

const enabled = process.env.XMACNA_INBOX_INTEGRATION === '1';

test('raw instance names that used to normalize alike remain tenant-isolated', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const inbox = new PrismaInboundInbox(repository as any);
  const suffix = randomUUID();
  const names = [`Tenant ${suffix}`, `Tenant-${suffix}`];
  const instanceIds = names.map((_, index) => `scope-${index}-${suffix}`);
  const sourceCluster = 'local-scope-isolation';
  const messageId = `same-wamid-${suffix}`;

  try {
    await repository.$connect();
    await repository.instance.createMany({
      data: names.map((name, index) => ({ id: instanceIds[index], name, inboundInboxMode: 'enforce' })),
    });
    const results = await Promise.all(
      names.map((name, index) =>
        inbox.claim(
          {
            sourceCluster,
            instanceId: instanceIds[index],
            instanceScope: normalizeInstanceScope(name),
            contactScope: 'contact@s.whatsapp.net',
            messageId,
            classification: 'real',
            payloadHash: 'a'.repeat(64),
            leaseOwner: `scope-worker-${index}`,
            messageData: {
              key: { id: messageId, remoteJid: 'contact@s.whatsapp.net', fromMe: false },
              pushName: 'Tenant isolation',
              messageType: 'conversation',
              message: { conversation: name },
              source: 'unknown',
              messageTimestamp: 1,
              instanceId: instanceIds[index],
            },
          },
          'enforce',
        ),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.shouldDispatch),
      [true, true],
    );
    assert.equal(
      await repository.inboundReceipt.count({
        where: { sourceCluster, messageId },
      }),
      2,
    );
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { sourceCluster, messageId } });
    await repository.instance.deleteMany({ where: { id: { in: instanceIds } } });
    await repository.$disconnect();
  }
});

test('840 concurrent deliveries create one receipt and one durable message', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const inbox = new PrismaInboundInbox(repository as any);
  const suffix = randomUUID();
  const instanceId = `inbox-test-${suffix}`;
  const messageId = `wamid-${suffix}`;

  try {
    await repository.$connect();
    await repository.instance.create({
      data: { id: instanceId, name: `inbox-test-${suffix}`, inboundInboxMode: 'enforce' },
    });

    const messageData = {
      key: { id: messageId, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      pushName: 'Teste local',
      messageType: 'conversation',
      message: { conversation: 'mensagem concorrente' },
      source: 'unknown' as const,
      messageTimestamp: 1,
      instanceId,
    };
    const input = {
      sourceCluster: 'local-concurrency',
      instanceId,
      instanceScope: `instance-${suffix}`,
      contactScope: '5511999999999@s.whatsapp.net',
      messageId,
      classification: 'real' as const,
      payloadHash: 'a'.repeat(64),
      messageData,
      leaseOwner: `test-${suffix}`,
      leaseSeconds: 60,
    };

    const results = await Promise.all(Array.from({ length: 840 }, () => inbox.claim(input, 'enforce')));
    assert.equal(results.filter((result) => result.shouldDispatch).length, 1);
    assert.equal(results.filter((result) => result.kind === 'claimed').length, 1);
    assert.equal(results.filter((result) => result.kind === 'duplicate').length, 839);

    const receipts = await repository.inboundReceipt.findMany({
      where: {
        sourceCluster: input.sourceCluster,
        instanceScope: input.instanceScope,
        messageId,
      },
    });
    assert.equal(receipts.length, 1);
    assert.ok(receipts[0].messageRecordId);
    assert.equal(receipts[0].duplicateCount, 839);
    assert.equal(await repository.message.count({ where: { instanceId } }), 1);

    const winner = results.find((result) => result.shouldDispatch)!;
    assert.equal(await inbox.markSink(winner.receiptId, 'chatwoot', 'sent', input.leaseOwner, winner.leaseToken), true);
    assert.equal(
      await inbox.markFailed(winner.receiptId, input.leaseOwner, winner.leaseToken!, 'webhook failed', 10, 0),
      true,
    );
    const immediateRetry = await inbox.claim({ ...input, leaseOwner: `retry-${suffix}` }, 'enforce');
    assert.equal(immediateRetry.kind, 'duplicate');
    assert.equal(immediateRetry.shouldDispatch, false);
    const failed = await repository.inboundReceipt.findUniqueOrThrow({ where: { id: winner.receiptId } });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.chatwootState, 'sent');
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { instanceScope: `instance-${suffix}` } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
  }
});

test('enforce downgrade serializes against a concurrent ingress claim', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const inbox = new PrismaInboundInbox(repository as any);
  const suffix = randomUUID();
  const instanceId = `mode-race-${suffix}`;
  const instanceName = `mode-race-${suffix}`;
  const instanceScope = normalizeInstanceScope(instanceName);
  const sourceCluster = 'local-mode-race';

  try {
    await repository.$connect();
    await repository.instance.create({ data: { id: instanceId, name: instanceName, inboundInboxMode: 'enforce' } });

    for (let iteration = 0; iteration < 30; iteration += 1) {
      const messageId = `mode-race-${iteration}-${suffix}`;
      const claim = inbox.claim(
        {
          sourceCluster,
          instanceId,
          instanceScope,
          contactScope: 'contact@s.whatsapp.net',
          messageId,
          classification: 'real',
          payloadHash: iteration.toString(16).padStart(64, '0'),
          leaseOwner: `mode-race-worker-${iteration}`,
          messageData: {
            key: { id: messageId, remoteJid: 'contact@s.whatsapp.net', fromMe: false },
            pushName: 'Mode race',
            messageType: 'conversation',
            message: { conversation: `mode race ${iteration}` },
            source: 'unknown',
            messageTimestamp: iteration + 1,
            instanceId,
          },
        },
        'enforce',
      );
      const downgrade = transitionInboundMode(repository as any, instanceName, sourceCluster, 'off');
      const [claimResult, downgradeResult] = await Promise.allSettled([claim, downgrade]);

      assert.notEqual(
        claimResult.status === 'fulfilled' && downgradeResult.status === 'fulfilled',
        true,
        'claim and downgrade must not both commit',
      );
      if (claimResult.status === 'fulfilled') {
        assert.equal(downgradeResult.status, 'rejected');
        assert.ok(downgradeResult.reason instanceof InboundModeTransitionBlockedError);
      } else {
        assert.equal(downgradeResult.status, 'fulfilled');
        assert.match(String(claimResult.reason), /mode changed before claim/);
      }

      await repository.inboundReceipt.deleteMany({ where: { sourceCluster, instanceScope, messageId } });
      await transitionInboundMode(repository as any, instanceName, sourceCluster, 'enforce');
    }
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { sourceCluster, instanceScope } });
    await repository.message.deleteMany({ where: { instanceId } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
  }
});

test('Chatwoot success followed by webhook failure replays the exact enriched payload', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const inbox = new PrismaInboundInbox(repository as any);
  const suffix = randomUUID();
  const instanceId = `payload-replay-${suffix}`;
  const instanceScope = `payload-replay-scope-${suffix}`;
  const sourceCluster = 'local-payload-replay';
  const messageId = `payload-${suffix}`;

  try {
    await repository.$connect();
    await repository.instance.create({
      data: { id: instanceId, name: `payload-replay-${suffix}`, inboundInboxMode: 'enforce' },
    });
    const claimed = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: '12345@lid',
        messageId,
        classification: 'real',
        payloadHash: 'd'.repeat(64),
        leaseOwner: 'payload-ingress',
        leaseSeconds: 60,
        messageData: {
          key: { id: messageId, remoteJid: '12345@lid', remoteJidAlt: '5511999999999@s.whatsapp.net', fromMe: false },
          pushName: 'Payload replay',
          messageType: 'pollUpdateMessage',
          message: { pollUpdateMessage: { vote: { selectedOptions: ['opcao-a'] } } },
          source: 'unknown',
          messageTimestamp: 1,
          instanceId,
        },
      },
      'enforce',
    );

    const afterPoll = {
      key: { id: messageId, remoteJid: '12345@lid', remoteJidAlt: '5511999999999@s.whatsapp.net', fromMe: false },
      pushName: 'Payload replay',
      messageType: 'pollUpdateMessage',
      message: { pollUpdateMessage: { vote: { selectedOptions: ['opcao-a'] } } },
      pollUpdates: [{ name: 'opcao-a', voters: ['12345@lid'] }],
      source: 'unknown',
      messageTimestamp: 1,
      instanceId,
    };
    assert.equal(
      await inbox.persistMessage(claimed.receiptId, 'payload-ingress', claimed.leaseToken!, afterPoll),
      true,
    );

    const afterChatwoot = {
      ...afterPoll,
      chatwootMessageId: 71,
      chatwootInboxId: 72,
      chatwootConversationId: 73,
    };
    assert.equal(
      await inbox.markSink(
        claimed.receiptId,
        'chatwoot',
        'sent',
        'payload-ingress',
        claimed.leaseToken,
        afterChatwoot,
      ),
      true,
    );

    const beforeWebhook = {
      ...afterChatwoot,
      key: { ...afterChatwoot.key, remoteJid: '5511999999999@s.whatsapp.net' },
      message: { ...afterChatwoot.message, base64: 'YmluYXJ5LW1lZGlh' },
    };
    assert.equal(
      await inbox.persistMessage(claimed.receiptId, 'payload-ingress', claimed.leaseToken!, beforeWebhook),
      true,
    );
    assert.equal(
      await inbox.markSink(claimed.receiptId, 'webhook', 'failed', 'payload-ingress', claimed.leaseToken),
      true,
    );
    assert.equal(
      await inbox.markFailed(claimed.receiptId, 'payload-ingress', claimed.leaseToken!, 'webhook failed', 10, 0),
      true,
    );

    const replay = await inbox.leaseNext(sourceCluster, instanceScope, 'payload-reconciler', 60, 10);
    assert.ok(replay);
    assert.equal(replay.chatwootState, 'sent');
    assert.equal(replay.webhookState, 'failed');
    assert.equal((replay.message as any).chatwootConversationId, 73);
    assert.equal((replay.message as any).key.remoteJid, '5511999999999@s.whatsapp.net');
    assert.equal((replay.message as any).message.base64, 'YmluYXJ5LW1lZGlh');
    assert.deepEqual((replay.message as any).pollUpdates, afterPoll.pollUpdates);
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { sourceCluster, instanceScope } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
  }
});

test('collision during an active lease cannot revoke fencing or quarantine the live delivery', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const inbox = new PrismaInboundInbox(repository as any);
  const suffix = randomUUID();
  const instanceId = `inflight-collision-${suffix}`;
  const instanceScope = `inflight-collision-scope-${suffix}`;
  const sourceCluster = 'local-inflight-collision';
  const messageId = `collision-${suffix}`;

  try {
    await repository.$connect();
    await repository.instance.create({
      data: { id: instanceId, name: instanceId, inboundInboxMode: 'enforce' },
    });
    const original = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId,
        classification: 'real',
        payloadHash: 'a'.repeat(64),
        leaseOwner: 'live-worker',
        leaseSeconds: 60,
        messageData: {
          key: { id: messageId, remoteJid: 'contact@s.whatsapp.net', fromMe: false },
          pushName: 'Collision',
          messageType: 'conversation',
          message: { conversation: 'original' },
          source: 'unknown',
          messageTimestamp: 1,
          instanceId,
        },
      },
      'enforce',
    );
    const collision = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId,
        classification: 'real',
        payloadHash: 'b'.repeat(64),
        leaseOwner: 'collision-worker',
      },
      'enforce',
    );
    assert.equal(collision.kind, 'collision');
    assert.equal(collision.shouldDispatch, false);
    const live = await repository.inboundReceipt.findUniqueOrThrow({ where: { id: original.receiptId } });
    assert.equal(live.state, 'processing');
    assert.equal(live.leaseOwner, 'live-worker');
    assert.equal(live.leaseToken, original.leaseToken);
    assert.equal(await inbox.markSink(original.receiptId, 'webhook', 'sent', 'live-worker', original.leaseToken), true);
    assert.equal(await inbox.markDone(original.receiptId, 'live-worker', original.leaseToken!), true);
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { sourceCluster, instanceScope } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
  }
});

test('Chatwoot failure can leave n8n/webhook sent and retries only the failed sink', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const inbox = new PrismaInboundInbox(repository as any);
  const suffix = randomUUID();
  const instanceId = `chatwoot-best-effort-${suffix}`;
  const instanceScope = `chatwoot-best-effort-scope-${suffix}`;
  const sourceCluster = 'local-chatwoot-best-effort';
  const messageId = `best-effort-${suffix}`;

  try {
    await repository.$connect();
    await repository.instance.create({ data: { id: instanceId, name: instanceId, inboundInboxMode: 'enforce' } });
    const claimed = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId,
        classification: 'real',
        payloadHash: 'f'.repeat(64),
        leaseOwner: 'ingress',
        leaseSeconds: 60,
        messageData: {
          key: { id: messageId, remoteJid: 'contact@s.whatsapp.net', fromMe: false },
          pushName: 'Best effort',
          messageType: 'conversation',
          message: { conversation: 'continue para n8n' },
          source: 'unknown',
          messageTimestamp: 1,
          instanceId,
        },
      },
      'enforce',
    );
    assert.equal(await inbox.markSink(claimed.receiptId, 'chatwoot', 'failed', 'ingress', claimed.leaseToken), true);
    assert.equal(await inbox.markSink(claimed.receiptId, 'webhook', 'sent', 'ingress', claimed.leaseToken), true);
    assert.equal(await inbox.markSink(claimed.receiptId, 'chatbot', 'sent', 'ingress', claimed.leaseToken), true);
    assert.equal(await inbox.markFailed(claimed.receiptId, 'ingress', claimed.leaseToken!, 'chatwoot unavailable', 10, 0), true);

    const replay = await inbox.leaseNext(sourceCluster, instanceScope, 'reconciler', 60, 10);
    assert.ok(replay);
    assert.equal(replay.chatwootState, 'failed');
    assert.equal(replay.webhookState, 'sent');
    assert.equal(replay.chatbotState, 'sent');
    assert.equal(await inbox.markSink(replay.receiptId, 'chatwoot', 'sent', replay.leaseOwner, replay.leaseToken), true);
    assert.equal(await inbox.markDone(replay.receiptId, replay.leaseOwner, replay.leaseToken), true);
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { sourceCluster, instanceScope } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
  }
});

test('control can promote to real and protocol replay dispatches only once in enforce', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const inbox = new PrismaInboundInbox(repository as any);
  const suffix = randomUUID();
  const instanceId = `classification-${suffix}`;
  const instanceScope = `classification-scope-${suffix}`;
  const sourceCluster = 'local-classification';

  try {
    await repository.$connect();
    await repository.instance.create({
      data: { id: instanceId, name: instanceId, inboundInboxMode: 'enforce' },
    });
    const controlId = `control-${suffix}`;
    const control = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId: controlId,
        classification: 'control',
        payloadHash: 'c'.repeat(64),
      },
      'enforce',
    );
    assert.equal(control.shouldDispatch, false);
    const promoted = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId: controlId,
        classification: 'real',
        payloadHash: 'd'.repeat(64),
        leaseOwner: 'promotion-worker',
        messageData: {
          key: { id: controlId, remoteJid: 'contact@s.whatsapp.net', fromMe: false },
          pushName: 'Promotion',
          messageType: 'conversation',
          message: { conversation: 'real' },
          source: 'unknown',
          messageTimestamp: 1,
          instanceId,
        },
      },
      'enforce',
    );
    assert.equal(promoted.kind, 'promoted');
    assert.equal(promoted.shouldDispatch, true);
    assert.equal(await inbox.markDone(promoted.receiptId, 'promotion-worker', promoted.leaseToken!), true);

    const protocolInput = {
      sourceCluster,
      instanceId,
      instanceScope,
      contactScope: 'contact@s.whatsapp.net',
      messageId: `protocol-${suffix}`,
      classification: 'protocol' as const,
      payloadHash: 'e'.repeat(64),
    };
    const firstProtocol = await inbox.claim(protocolInput, 'enforce');
    const replayedProtocol = await inbox.claim(protocolInput, 'enforce');
    assert.equal(firstProtocol.shouldDispatch, true);
    assert.equal(replayedProtocol.kind, 'duplicate');
    assert.equal(replayedProtocol.shouldDispatch, false);
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { sourceCluster, instanceScope } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
  }
});

test('reconciler leases with fencing, preserves completed sinks and orders each contact', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const inbox = new PrismaInboundInbox(repository as any);
  const suffix = randomUUID();
  const instanceId = `worker-test-${suffix}`;
  const instanceScope = `worker-instance-${suffix}`;
  const sourceCluster = 'local-worker';
  const receiptIds: string[] = [];

  const claim = async (messageId: string, contactScope: string, leaseOwner: string) => {
    const result = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope,
        messageId,
        classification: 'real',
        payloadHash: messageId.padEnd(64, '0').slice(0, 64),
        leaseOwner,
        leaseSeconds: 60,
        messageData: {
          key: { id: messageId, remoteJid: contactScope, fromMe: false },
          pushName: 'Teste local',
          messageType: 'conversation',
          message: { conversation: messageId },
          source: 'unknown',
          messageTimestamp: 1,
          instanceId,
        },
      },
      'enforce',
    );
    receiptIds.push(result.receiptId);
    return result;
  };

  try {
    await repository.$connect();
    await repository.instance.create({
      data: { id: instanceId, name: `worker-test-${suffix}`, inboundInboxMode: 'enforce' },
    });

    const first = await claim(`first-${suffix}`, 'contact-a@s.whatsapp.net', 'ingress-first');
    const second = await claim(`second-${suffix}`, 'contact-a@s.whatsapp.net', 'ingress-second');
    const third = await claim(`third-${suffix}`, 'contact-b@s.whatsapp.net', 'ingress-third');
    await repository.inboundReceipt.update({
      where: { id: first.receiptId },
      data: { createdAt: new Date('2026-01-01T00:00:00Z'), leaseExpiresAt: new Date(0) },
    });
    await repository.inboundReceipt.update({
      where: { id: second.receiptId },
      data: { createdAt: new Date('2026-01-01T00:00:01Z'), leaseExpiresAt: new Date(0) },
    });
    await repository.inboundReceipt.update({
      where: { id: third.receiptId },
      data: { createdAt: new Date('2026-01-01T00:00:02Z'), leaseExpiresAt: new Date(0) },
    });

    const [leasedA, leasedB] = await Promise.all([
      inbox.leaseNext(sourceCluster, instanceScope, 'worker-a', 60, 10),
      inbox.leaseNext(sourceCluster, instanceScope, 'worker-b', 60, 10),
    ]);
    const leased = [leasedA, leasedB].filter(Boolean);
    assert.equal(leased.length, 2);
    assert.deepEqual(
      new Set(leased.map((item) => item!.receiptId)),
      new Set([first.receiptId, third.receiptId]),
    );

    const oldest = leased.find((item) => item!.receiptId === first.receiptId)!;
    assert.equal(await inbox.markSink(oldest.receiptId, 'chatwoot', 'sent', oldest.leaseOwner, oldest.leaseToken), true);
    assert.equal(await inbox.markFailed(oldest.receiptId, oldest.leaseOwner, oldest.leaseToken, 'simulated kill', 10, 0), true);
    const resumed = await inbox.leaseNext(sourceCluster, instanceScope, 'worker-resume', 60, 10);
    assert.equal(resumed?.receiptId, first.receiptId);
    assert.equal(resumed?.chatwootState, 'sent');
    assert.equal(resumed?.webhookState, 'pending');
    assert.equal(resumed?.chatbotState, 'pending');
    assert.equal(await inbox.heartbeat(resumed!.receiptId, resumed!.leaseOwner, resumed!.leaseToken, 60), true);
    assert.equal(await inbox.heartbeat(resumed!.receiptId, 'stale-owner', resumed!.leaseToken, 60), false);
    assert.equal(await inbox.markDone(resumed!.receiptId, resumed!.leaseOwner, resumed!.leaseToken), true);

    const nextSameContact = await inbox.leaseNext(sourceCluster, instanceScope, 'worker-next', 60, 10);
    assert.equal(nextSameContact?.receiptId, second.receiptId);
    assert.equal(
      await inbox.markFailed(
        nextSameContact!.receiptId,
        nextSameContact!.leaseOwner,
        nextSameContact!.leaseToken,
        'terminal failure',
        2,
        0,
      ),
      true,
    );
    assert.equal(
      (await repository.inboundReceipt.findUniqueOrThrow({ where: { id: second.receiptId } })).state,
      'dead',
    );
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { id: { in: receiptIds } } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
  }
});

test('stub promotes, collisions quarantine and instance recreation keeps the tombstone', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const inbox = new PrismaInboundInbox(repository as any);
  const suffix = randomUUID();
  const instanceScope = `stable-name-${suffix}`;
  const messageId = `stub-real-${suffix}`;
  const sourceCluster = 'local-promotion';
  let instanceId = `old-${suffix}`;
  let receiptId: string | undefined;

  const messageData = () => ({
    key: { id: messageId, remoteJid: 'contact@s.whatsapp.net', fromMe: false },
    pushName: 'Teste local',
    messageType: 'conversation',
    message: { conversation: 'conteúdo real' },
    source: 'unknown' as const,
    messageTimestamp: 1,
    instanceId,
  });

  try {
    await repository.$connect();
    await repository.instance.create({ data: { id: instanceId, name: instanceScope, inboundInboxMode: 'enforce' } });
    const stub = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId,
        classification: 'stub',
        payloadHash: 'a'.repeat(64),
      },
      'enforce',
    );
    receiptId = stub.receiptId;
    assert.equal(stub.shouldDispatch, false);

    const realInput = {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId,
        classification: 'real',
        payloadHash: 'b'.repeat(64),
        messageData: messageData(),
        leaseOwner: 'promotion-worker',
        leaseSeconds: 60,
      } as const;
    const concurrentPromotions = await Promise.all(
      Array.from({ length: 100 }, () => inbox.claim(realInput, 'enforce')),
    );
    const promoted = concurrentPromotions.find((result) => result.kind === 'promoted')!;
    assert.equal(concurrentPromotions.filter((result) => result.kind === 'promoted').length, 1);
    assert.equal(concurrentPromotions.filter((result) => result.kind === 'duplicate').length, 99);
    assert.equal(promoted.kind, 'promoted');
    assert.equal(promoted.shouldDispatch, true);
    assert.equal(await inbox.markDone(promoted.receiptId, 'promotion-worker', promoted.leaseToken!), true);

    const collision = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId,
        classification: 'real',
        payloadHash: 'c'.repeat(64),
        messageData: messageData(),
        leaseOwner: 'collision-worker',
      },
      'enforce',
    );
    assert.equal(collision.kind, 'collision');
    assert.equal(collision.shouldDispatch, false);
    assert.equal((await repository.inboundReceipt.findUniqueOrThrow({ where: { id: receiptId } })).state, 'quarantined');
    await repository.inboundReceipt.update({
      where: { id: receiptId },
      data: { leaseExpiresAt: new Date(0) },
    });

    await repository.instance.delete({ where: { id: instanceId } });
    instanceId = `new-${suffix}`;
    await repository.instance.create({ data: { id: instanceId, name: instanceScope, inboundInboxMode: 'enforce' } });
    const replay = await inbox.claim(
      {
        sourceCluster,
        instanceId,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId,
        classification: 'real',
        payloadHash: 'b'.repeat(64),
        messageData: messageData(),
        leaseOwner: 'new-instance-worker',
      },
      'enforce',
    );
    assert.equal(replay.shouldDispatch, false);
    const quarantined = await repository.inboundReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    assert.equal(quarantined.state, 'quarantined');
    assert.equal(await repository.inboundReceipt.count({ where: { id: receiptId } }), 1);
  } finally {
    if (receiptId) await repository.inboundReceipt.deleteMany({ where: { id: receiptId } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
  }
});

test('historical backfill never queues replay and tombstones migrate with rewritten scope', { skip: !enabled }, async () => {
  const repository = new PrismaClient();
  const suffix = randomUUID();
  const instanceId = `backfill-${suffix}`;
  const instanceName = `Backfill ${suffix}`;
  const sourceCluster = 'local-backfill';
  const targetCluster = 'local-target';
  const targetScope = `Migrated ${suffix}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'xmacna-inbox-'));
  const manifestPath = join(tempDir, 'tombstones.json');

  try {
    await repository.$connect();
    await repository.instance.create({ data: { id: instanceId, name: instanceName } });
    await repository.message.createMany({
      data: [1, 2].map((index) => ({
        key: { id: `historical-${suffix}-${index}`, remoteJid: 'history@s.whatsapp.net', fromMe: false },
        pushName: 'Histórico',
        messageType: 'conversation',
        message: { conversation: `histórico ${index}` },
        source: 'unknown',
        messageTimestamp: index,
        instanceId,
      })),
    });

    await backfill(repository, {
      command: 'backfill',
      sourceCluster,
      instanceName,
      batchSize: 1,
      live: true,
    });
    const historical = await repository.inboundReceipt.findMany({ where: { sourceCluster } });
    assert.equal(historical.length, 2);
    assert.ok(historical.every((row) => row.state === 'historical_seen'));
    assert.ok(historical.every((row) => row.webhookState === 'skipped'));

    await exportTombstones(repository, {
      command: 'export',
      sourceCluster,
      instanceName,
      output: manifestPath,
      batchSize: 500,
      live: false,
    });
    assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
    await importTombstones(repository, {
      command: 'import',
      input: manifestPath,
      targetCluster,
      targetScope,
      batchSize: 500,
      live: true,
    });
    const imported = await repository.inboundReceipt.findMany({ where: { sourceCluster: targetCluster } });
    assert.equal(imported.length, 2);
    assert.ok(imported.every((row) => row.instanceScope === normalizeInstanceScope(targetScope)));
    assert.ok(imported.every((row) => row.messageRecordId === null && row.state === 'historical_seen'));
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { sourceCluster: { in: [sourceCluster, targetCluster] } } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
