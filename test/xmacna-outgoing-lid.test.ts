import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { enrichOutgoingMessageKey, remoteJidQueryFilters } from '../src/api/integrations/channel/whatsapp/outgoingLid';

const phone = '5511999999999@s.whatsapp.net';
const lid = '123456789@lid';

test('number destination enriches a returned LID key and number query finds it', () => {
  const key = enrichOutgoingMessageKey({ remoteJid: lid, fromMe: true, id: 'sent-1' }, [phone]);
  assert.deepEqual(key, { remoteJid: lid, remoteJidAlt: phone, fromMe: true, id: 'sent-1' });
  assert.equal(remoteJidQueryFilters({ remoteJid: phone }).some((filter) => {
    const [field] = filter.key.path;
    return key[field as keyof typeof key] === filter.key.equals;
  }), true);
});

test('Baileys PN and cache candidates enrich an outgoing LID echo', () => {
  assert.equal(enrichOutgoingMessageKey({ remoteJid: lid, fromMe: true, remoteJidAlt: phone }, []).remoteJidAlt, phone);
  assert.equal(enrichOutgoingMessageKey({ remoteJid: lid, fromMe: true }, [phone]).remoteJidAlt, phone);
  assert.equal(
    enrichOutgoingMessageKey({ remoteJid: lid, fromMe: true, remoteJidAlt: '5521999999999@s.whatsapp.net' }, [phone])
      .remoteJidAlt,
    phone,
  );
});

test('groups, broadcasts, inbound and unknown numbers remain unchanged', () => {
  for (const key of [
    { remoteJid: '123@g.us', fromMe: true },
    { remoteJid: 'status@broadcast', fromMe: true },
    { remoteJid: lid, fromMe: false },
    { remoteJid: lid, fromMe: true },
  ]) {
    assert.deepEqual(enrichOutgoingMessageKey(key, [key.fromMe ? '123@g.us' : phone]), key);
  }
});

test('query without a JID keeps the unfiltered behavior', () => {
  assert.deepEqual(remoteJidQueryFilters({}), [{}]);
});

test('both persistence paths enrich before writing; fetch applies the same OR to count and results', () => {
  const source = readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8');
  const echo = source.slice(source.indexOf("'messages.upsert': async ("), source.indexOf("'messages.update': async"));
  const send = source.slice(source.indexOf('private async sendMessageWithTyping'), source.indexOf('public async textMessage'));
  const fetch = source.slice(source.indexOf('public async fetchMessages'));
  for (const path of [echo, send]) {
    const enrich = path.indexOf('messageRaw.key = enrichOutgoingMessageKey(');
    const create = path.indexOf('prismaRepository.message.create(');
    assert.ok(enrich >= 0 && create > enrich);
  }
  assert.equal(fetch.match(/OR: remoteJidQueryFilters\(keyFilters\)/g)?.length, 2);
});
