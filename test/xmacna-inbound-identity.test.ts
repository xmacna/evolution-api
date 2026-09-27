import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LidPhoneAliasStore,
  resolveInboundAddress,
  UnresolvedInboundLidError,
} from '../src/api/integrations/channel/whatsapp/inboundIdentity';
import { normalizeInstanceScope } from '../src/api/integrations/channel/whatsapp/inboundInbox';

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
