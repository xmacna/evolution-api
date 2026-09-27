import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { buildChatbotDebounceKey, processChatbotDebounce } from '../src/api/integrations/chatbot/chatbotDebounce';
import { PrismaLidPhoneAliasStore, resolveInboundAddress } from '../src/api/integrations/channel/whatsapp/inboundIdentity';
import { inboundPayloadHash, normalizeContactScope, normalizeInstanceScope, PrismaInboundInbox } from '../src/api/integrations/channel/whatsapp/inboundInbox';

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
