import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { PrismaInboundInbox } from '../src/api/integrations/channel/whatsapp/inboundInbox';
import { backfill, exportTombstones, importTombstones } from '../src/cli/inboundInboxMaintenance';

const enabled = process.env.XMACNA_INBOX_INTEGRATION === '1';

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
    assert.equal(await repository.message.count({ where: { instanceId } }), 1);
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { instanceScope: `instance-${suffix}` } });
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

    const promoted = await inbox.claim(
      {
        sourceCluster,
        instanceScope,
        contactScope: 'contact@s.whatsapp.net',
        messageId,
        classification: 'real',
        payloadHash: 'b'.repeat(64),
        messageData: messageData(),
        leaseOwner: 'promotion-worker',
        leaseSeconds: 60,
      },
      'enforce',
    );
    assert.equal(promoted.kind, 'promoted');
    assert.equal(promoted.shouldDispatch, true);
    assert.equal(await inbox.markDone(promoted.receiptId, 'promotion-worker', promoted.leaseToken!), true);

    const collision = await inbox.claim(
      {
        sourceCluster,
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

    await repository.instance.delete({ where: { id: instanceId } });
    instanceId = `new-${suffix}`;
    await repository.instance.create({ data: { id: instanceId, name: instanceScope, inboundInboxMode: 'enforce' } });
    const replay = await inbox.claim(
      {
        sourceCluster,
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
    assert.ok(imported.every((row) => row.instanceScope === targetScope.toLowerCase().replace(/\s+/g, '-')));
    assert.ok(imported.every((row) => row.messageRecordId === null && row.state === 'historical_seen'));
  } finally {
    await repository.inboundReceipt.deleteMany({ where: { sourceCluster: { in: [sourceCluster, targetCluster] } } });
    await repository.instance.deleteMany({ where: { id: instanceId } });
    await repository.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
