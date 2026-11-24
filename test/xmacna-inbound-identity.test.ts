import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LidPhoneAliasStore,
  resolveDeliverableInboundAddress,
  resolveInboundAddress,
  UnresolvedInboundLidError,
} from '../src/api/integrations/channel/whatsapp/inboundIdentity';
import { normalizeInstanceScope } from '../src/api/integrations/channel/whatsapp/inboundInbox';
import { dispatchInboundChatbot } from '../src/api/integrations/channel/whatsapp/inboundSinkDispatch';

class MemoryAliases implements LidPhoneAliasStore {
  private rows = new Map<string, string | null>();
  private key(scope: string, lid: string) {
    return JSON.stringify([scope, lid]);
  }
  async confirm(scope: string, lid: string, phone: string) {
    const key = this.key(scope, lid);
    if (this.rows.has(key) && this.rows.get(key) !== phone) this.rows.set(key, null);
    else if (!this.rows.has(key)) this.rows.set(key, phone);
    const result = this.rows.get(key);
    if (!result) throw new UnresolvedInboundLidError('ambiguous');
    return result;
  }
  async find(scope: string, lid: string) {
    const result = this.rows.get(this.key(scope, lid));
    if (result === null) throw new UnresolvedInboundLidError('ambiguous');
    return result ?? null;
  }
}

const phone = '5511999999999@s.whatsapp.net';
const lid = '118837617901692@lid';

test('a confirmed remoteJidAlt persists for a later LID-only event and keeps the reply destination', async () => {
  const aliases = new MemoryAliases();
  const first = await resolveInboundAddress('Taubaté', { remoteJid: lid, remoteJidAlt: phone }, aliases);
  const restartedProcess = await resolveInboundAddress('Taubaté', { remoteJid: lid }, aliases, async () => null);
  assert.deepEqual(first, { remoteJid: phone, senderLid: lid });
  assert.deepEqual(restartedProcess, first);
  assert.equal(await aliases.find(normalizeInstanceScope('Taubaté'), lid), phone);
});

test('Baileys contact is accepted only when it returns a full phone JID', async () => {
  const aliases = new MemoryAliases();
  assert.deepEqual(
    await resolveInboundAddress('Taubaté', { remoteJid: lid }, aliases, async () => phone),
    { remoteJid: phone, senderLid: lid },
  );
  await assert.rejects(
    resolveInboundAddress('Other', { remoteJid: lid }, aliases, async () => '5511999999999'),
    /unknown/,
  );
});

test('unknown, conflicting and cross-instance aliases fail without deriving digits from the LID', async () => {
  const aliases = new MemoryAliases();
  await assert.rejects(resolveInboundAddress('Taubaté', { remoteJid: lid }, aliases), /unknown/);
  await resolveInboundAddress('Taubaté', { remoteJid: lid, remoteJidAlt: phone }, aliases);
  await assert.rejects(resolveInboundAddress('Other', { remoteJid: lid }, aliases), /unknown/);
  await assert.rejects(
    resolveInboundAddress(
      'Taubaté',
      { remoteJid: lid, remoteJidAlt: '5511888888888@s.whatsapp.net' },
      aliases,
    ),
    /ambiguous/,
  );
  await assert.rejects(resolveInboundAddress('Taubaté', { remoteJid: lid }, aliases), /ambiguous/);
});

test('a phone event with alternate LID confirms the alias for a later LID event', async () => {
  const aliases = new MemoryAliases();
  assert.deepEqual(
    await resolveInboundAddress('Taubaté', { remoteJid: phone, remoteJidAlt: lid }, aliases),
    { remoteJid: phone, senderLid: undefined },
  );
  assert.deepEqual(await resolveInboundAddress('Taubaté', { remoteJid: lid }, aliases), {
    remoteJid: phone,
    senderLid: lid,
  });
});

test('group addresses do not become a member phone through an alternate LID', async () => {
  const aliases = new MemoryAliases();
  assert.deepEqual(
    await resolveInboundAddress('Taubaté', { remoteJid: '123456@g.us', remoteJidAlt: lid }, aliases),
    { remoteJid: '123456@g.us' },
  );
});

// xmacna/elysium#1495: Tacomaq #614/#617 were paid-ad leads that arrived as a bare LID in enforce.
// Chatwoot got them, the chatbot sink threw until the receipt went dead, and n8n never ran.
test('every delivery reaches the bot: phone, LID with phone and bare LID', async () => {
  const aliases = new MemoryAliases();
  const cases = [
    { name: 'phone', key: { remoteJid: phone }, remoteJid: phone, senderLid: undefined, unresolved: false },
    { name: 'LID + phone', key: { remoteJid: lid, remoteJidAlt: phone }, remoteJid: phone, senderLid: lid, unresolved: false },
    { name: 'bare LID', key: { remoteJid: '150401332576367@lid' }, remoteJid: '150401332576367@lid', senderLid: undefined, unresolved: true },
  ];
  for (const delivery of cases) {
    const address = await resolveDeliverableInboundAddress('manuela-tacomaq', delivery.key, aliases, async () => null);
    assert.equal(address.remoteJid, delivery.remoteJid, delivery.name);
    assert.equal(address.senderLid, delivery.senderLid, delivery.name);
    assert.equal(address.unresolved instanceof UnresolvedInboundLidError, delivery.unresolved, delivery.name);
    const calls: string[] = [];
    await dispatchInboundChatbot({
      attempt: async (operation) => { await operation(); return true; },
      durable: async () => { calls.push(`n8n:${address.remoteJid}`); },
      bestEffort: async () => { calls.push(`best-effort:${address.remoteJid}`); },
    });
    assert.deepEqual(calls, [`n8n:${delivery.remoteJid}`, `best-effort:${delivery.remoteJid}`], delivery.name);
  }
});

test('a bare LID goes to the bot under the LID until the phone is known, then under the phone', async () => {
  const aliases = new MemoryAliases();
  const before = await resolveDeliverableInboundAddress('Taubaté', { remoteJid: lid }, aliases, async () => null);
  assert.equal(before.remoteJid, lid);
  assert.ok(before.unresolved);
  await resolveInboundAddress('Taubaté', { remoteJid: lid, remoteJidAlt: phone }, aliases);
  assert.deepEqual(
    await resolveDeliverableInboundAddress('Taubaté', { remoteJid: lid }, aliases, async () => null),
    { remoteJid: phone, senderLid: lid },
  );
});

test('an ambiguous LID is delivered as it came, never as a guessed phone', async () => {
  const aliases = new MemoryAliases();
  await resolveInboundAddress('Taubaté', { remoteJid: lid, remoteJidAlt: phone }, aliases);
  const conflict = { remoteJid: lid, remoteJidAlt: '5511888888888@s.whatsapp.net' };
  const address = await resolveDeliverableInboundAddress('Taubaté', conflict, aliases, async () => null);
  assert.equal(address.remoteJid, lid);
  assert.match(address.unresolved!.message, /ambiguous/);
});

test('store failures still reject instead of being delivered as unresolved', async () => {
  const broken: LidPhoneAliasStore = {
    confirm: async () => { throw new Error('db down'); },
    find: async () => { throw new Error('db down'); },
  };
  await assert.rejects(
    resolveDeliverableInboundAddress('Taubaté', { remoteJid: lid }, broken, async () => null),
    /db down/,
  );
});

test('the same message ID with and without alternate JID stays in one phone session', async () => {
  const aliases = new MemoryAliases();
  const deliveries = [
    { id: 'wamid-mirtes', remoteJid: lid, remoteJidAlt: phone },
    { id: 'wamid-mirtes', remoteJid: lid },
  ];
  const sessions = new Set<string>();
  for (const delivery of deliveries) {
    const resolved = await resolveInboundAddress('Taubaté', delivery, aliases, async () => null);
    sessions.add(`bot_${resolved.remoteJid.split('@')[0]}`);
  }
  assert.deepEqual([...sessions], ['bot_5511999999999']);
});
