const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');

// Transpile production classes; never import server.module, real DB or network clients.
// Unknown dependencies fail loudly if an unplanned runtime boundary is exercised.
const events = { MESSAGES_UPSERT: 'messages.upsert', MESSAGES_UPDATE: 'messages.update',
  MESSAGES_DELETE: 'messages.delete', CONTACTS_UPSERT: 'contacts.upsert', CONTACTS_UPDATE: 'contacts.update' };
function load(relative, boundaries = {}) {
  const filename = path.join(__dirname, '..', relative);
  const exports = {};
  const context = { exports, module: { exports }, Buffer, console, URL, setTimeout: fn => { fn(); return 0; }, process: { env: {} },
    require(name) {
      if (name in boundaries) return boundaries[name];
      if (['crypto', 'path', 'stream', 'util', 'node:crypto', 'express-rate-limit'].includes(name)) return require(name);
      if (name === '@api/types/wa.types') return { Events: events };
      if (name === '@api/services/channel.service') return { ChannelStartupService: class {
        get instanceId() { return this.instance.id; }
      } };
      if (name === '../channel.controller') return { ChannelController: class {
        constructor(prisma, monitor) { this.prismaRepository = prisma; this.waMonitor = monitor; }
      } };
      if (name === '@config/logger.config') return { Logger: class { error() {} warn() {} } };
      if (name === '@exceptions') return { InternalServerErrorException: class extends Error {}, BadRequestException: class extends Error {} };
      if (name === '@utils/sendTelemetry') return { sendTelemetry() {} };
      if (name === '@utils/createJid') return load('src/utils/createJid.ts');
      if (name === 'form-data') return class { fields = []; append(...v) { this.fields.push(v); } getHeaders() { return {}; } };
      // These imports only initialize pure helpers; no actual dependency code is loaded.
      return new Proxy({}, { get(_t, key) {
        if (key === '__esModule') return false;
        throw new Error(`Unexpected runtime dependency ${name}.${String(key)}`);
      } });
    },
  };
  vm.runInNewContext(transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code,
    context, { filename });
  return context.module.exports;
}
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/meta-coexistence', name + '.json')));
const value = p => p.entry[0].changes[0].value;
const copy = x => JSON.parse(JSON.stringify(x));
function harness(options = {}) {
  const records = options.records || new Map();
  const calls = { pause: [], portal: [], bots: [], webhooks: [], contacts: [], updates: [], loads: 0 };
  const http = { post: async (url, body, config) => {
    assert.equal(url, 'https://partenon.local.invalid/pause', 'echo must never send a WhatsApp message');
    calls.pause.push({ body, config });
    if (options.pauseError) throw new Error('pause unavailable');
    return { data: options.pauseResponse || { ok: true, verified: true, paused: true } };
  } };
  const { BusinessStartupService } = load('src/api/integrations/channel/meta/whatsapp.business.service.ts', {
    axios: http, '@api/server.module': { chatbotController: { emit: async data => calls.bots.push(data) } },
  });
  const service = Object.create(BusinessStartupService.prototype);
  service.instance = { id: options.id || 'instance-local-a', name: options.name || 'local-a' };
  service.number = options.phoneId || 'phone-local-a';
  service.logger = { error() {}, log() {}, warn() {} };
  service.configService = { get(key) { return {
    WA_BUSINESS: { COEXISTENCE_PAUSE_URL: 'https://partenon.local.invalid/pause', COEXISTENCE_PAUSE_TOKEN: 'synthetic-token', ...options.config },
    DATABASE: { SAVE_DATA: { NEW_MESSAGE: true } }, CHATWOOT: { ENABLED: options.chatwoot !== false },
    S3: { ENABLE: false }, OPENAI: { ENABLED: false },
  }[key]; } };
  service.localChatwoot = { enabled: options.chatwoot !== false };
  service.localWebhook = { enabled: false };
  service.localSettings = {};
  service.loadChatwoot = async () => { calls.loads++; };
  service.findSettings = async () => ({});
  service.sendDataWebhook = (...args) => calls.webhooks.push(args);
  service.prismaRepository = {
    message: {
      findUnique: async ({ where }) => records.get(where.id) || null,
      findFirst: async ({ where }) => [...records.values()].find(m => m.instanceId === where.instanceId && m.key.id === where.key.equals) || null,
      create: async ({ data }) => {
        if (options.persistError) throw new Error('persist unavailable');
        const id = data.id || 'record-' + records.size;
        if (records.has(id)) throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
        const record = { ...copy(data), id }; records.set(id, record); return record;
      },
      update: async ({ where, data }) => {
        if (options.finalPersistError && data.status === 'COEXISTENCE_ECHO_DONE') throw new Error('persist final unavailable');
        const record = { ...records.get(where.id), ...copy(data) }; records.set(where.id, record); return record;
      },
    },
    integrationSession: { updateMany: async args => { calls.updates.push(args); return { count: options.sessions ?? 0 }; } },
    messageUpdate: { create: async args => calls.updates.push(args) },
    contact: { findFirst: async () => null, create: async args => calls.contacts.push(args), updateMany: async args => calls.contacts.push(args) },
  };
  service.chatwootService = { eventWhatsapp: async () => ({ id: 92 }), prepareBusinessAppEcho: async () => 34, mirrorBusinessAppEcho: async (...args) => {
    calls.portal.push(args);
    if (options.portalError) throw new Error('portal unavailable');
    return { id: 91, inbox_id: 12, conversation_id: 34 };
  } };
  return { service, calls, records, options };
}

test('empty/unknown changes and absent arrays do not dereference statuses[0]', async () => {
  for (const content of [{}, { messages: [] }, { statuses: [] }, { message_echoes: [] }]) {
    const h = harness(); const p = fixture('echo-text'); p.entry[0].changes[0].value = content;
    await h.service.connectToWhatsapp(p);
    assert.equal(h.calls.bots.length + h.calls.portal.length, 0);
  }
});

test('official echo: durable fromMe, verified human pause and Portal, no bot/inbound/contact side effects', async () => {
  const h = harness(); await h.service.connectToWhatsapp(fixture('echo-text'));
  assert.equal(h.calls.pause.length, 1); assert.equal(h.calls.portal.length, 1);
  const msg = h.calls.portal[0][1];
  assert.equal(msg.key.fromMe, true); assert.equal(msg.key.remoteJid, '15550000002@s.whatsapp.net');
  assert.equal(msg.message.conversation, 'Synthetic app reply');
  assert.equal(h.calls.pause[0].body.phoneNumberId, 'phone-local-a');
  assert.equal(h.calls.pause[0].body.conversationId, 34);
  assert.equal(h.calls.pause[0].config.headers['x-partenon-secret'], 'synthetic-token');
  assert.equal(h.calls.bots.length + h.calls.webhooks.length + h.calls.contacts.length, 0);
  const record = [...h.records.values()][0];
  assert.equal(record.status, 'COEXISTENCE_ECHO_DONE');
  assert.equal(record.chatwootMessageId, 91); assert.equal(record.chatwootInboxId, 12); assert.equal(record.chatwootConversationId, 34);
  assert.equal(h.calls.updates[0].where.instanceId, 'instance-local-a');
  assert.equal(h.calls.updates[0].data.status, 'paused');
});

test('awaits failure, retries pending Portal delivery, and suppresses completed duplicates', async () => {
  const h = harness({ portalError: true });
  await assert.rejects(h.service.connectToWhatsapp(fixture('echo-text')), /portal unavailable/);
  assert.notEqual([...h.records.values()][0]?.status, 'COEXISTENCE_ECHO_DONE');
  h.options.portalError = false;
  await h.service.connectToWhatsapp(fixture('echo-text'));
  await h.service.connectToWhatsapp(fixture('echo-text'));
  assert.equal(h.calls.portal.length, 2); assert.equal(h.records.size, 1);
  assert.equal(h.calls.pause.length, 2);
});

test('same stable message id remains isolated across instances', async () => {
  const records = new Map(); const a = harness({ records }); const b = harness({ records, id: 'instance-local-b' });
  await a.service.connectToWhatsapp(fixture('echo-text')); await b.service.connectToWhatsapp(fixture('echo-text'));
  assert.equal(records.size, 2); assert.equal(a.calls.portal.length + b.calls.portal.length, 2);
});

test('concurrent deliveries share work until acknowledgment', async () => {
  const h = harness(); await Promise.all([h.service.connectToWhatsapp(fixture('echo-text')), h.service.connectToWhatsapp(fixture('echo-text'))]);
  assert.equal(h.records.size, 1); assert.equal(h.calls.portal.length, 1);
});

test('pause failures, missing configuration and unverified response cannot be acknowledged', async () => {
  for (const options of [{ pauseError: true }, { pauseResponse: { ok: true, paused: true } }, { config: { COEXISTENCE_PAUSE_TOKEN: '' } }]) {
    const h = harness(options);
    await assert.rejects(h.service.connectToWhatsapp(fixture('echo-text')), /pause|Pause/);
    assert.equal(h.calls.portal.length, 0); assert.equal(h.calls.bots.length, 0);
  }
});

test('a verified superseding resume is accepted without repausing native sessions', async () => {
  const h = harness({ pauseResponse: { ok: true, verified: true, paused: false, ignored: true, reason: 'superseded_by_resume' } });
  await h.service.connectToWhatsapp(fixture('echo-text'));
  assert.equal(h.calls.portal.length, 1); assert.equal(h.calls.updates.length, 0);
});

test('BSUID-only is a valid unsupported identity: explicit failure without a fake JID or success', async () => {
  const p = fixture('echo-text'); delete value(p).message_echoes[0].to; delete value(p).contacts[0].wa_id;
  value(p).contacts[0].profile = { username: 'synthetic-user' };
  const h = harness(); await assert.rejects(h.service.connectToWhatsapp(p), /BSUID.*unsupported|unsupported.*BSUID/i);
  assert.equal(h.records.size + h.calls.portal.length + h.calls.bots.length, 0);
});

test('foreign phone binding is rejected and malformed batch is guarded', async () => {
  const h = harness(); const p = fixture('echo-text'); value(p).metadata.phone_number_id = 'phone-other';
  await assert.rejects(h.service.connectToWhatsapp(p), /phone.*mismatch|another instance/i);
  assert.equal(h.records.size, 0);
  await h.service.connectToWhatsapp({ entry: [] });
});

test('all echoes/entries/changes processed, preserving official inbound and status control behavior', async () => {
  const h = harness(); const p = fixture('echo-text');
  const second = copy(value(p).message_echoes[0]); second.id = 'wamid.LOCAL.echo.2'; second.to = '15550000003';
  value(p).message_echoes.push(second);
  p.entry[0].changes.push(...fixture('inbound-text').entry[0].changes);
  p.entry.push(...fixture('status-delivered').entry);
  await h.service.connectToWhatsapp(p);
  assert.equal(h.calls.portal.length, 2); assert.equal(h.calls.bots.length, 1);
  assert.equal(h.calls.bots[0].msg.key.fromMe, false);
  assert.equal(h.calls.bots[0].remoteJid, '15550000002@s.whatsapp.net');
});

test('unknown status message does not swallow subsequent delivered status', async () => {
  const h = harness(); h.records.set('sent', { id: 'sent', instanceId: 'instance-local-a', key: { id: 'wamid.LOCAL.sent.1', remoteJid: '15550000002@s.whatsapp.net', fromMe: true } });
  const p = fixture('status-delivered'); value(p).statuses.unshift({ ...copy(value(p).statuses[0]), id: 'unknown' });
  await h.service.connectToWhatsapp(p);
  assert.equal(h.calls.updates.length, 1); assert.equal(h.calls.updates[0].data.status, 'DELIVERED');
  assert.equal(h.calls.updates[0].data.fromMe, true);
});

test('persistence failure propagates and never acknowledges partial echo', async () => {
  const h = harness({ persistError: true }); await assert.rejects(h.service.connectToWhatsapp(fixture('echo-text')), /persist unavailable/);
  assert.equal(h.calls.portal.length + h.calls.bots.length, 0);
});

function portalHarness(options = {}) {
  const calls = { creates: [], reads: [], media: [] }; let existing = null;
  const { ChatwootService } = load('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', {
    '@api/integrations/chatbot/chatwoot/libs/postgres.client': { postgresClient: { getChatwootConnection: () => null } },
    '@api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper': { chatwootImport: {
      getExistingMessageBySourceId: async (...args) => { calls.reads.push(args); return existing && options.partialAck ? { id: existing.id } : existing; },
      getExistingSourceIds: async () => new Set(existing ? ['WAID:wamid.LOCAL.echo.1'] : []),
    } },
    '@utils/i18n': {}, 'dayjs': {}, 'long': {}, 'mime-types': { extension: () => 'jpg' }, 'baileys': {},
    axios: { request: async args => { calls.media.push(args); existing = { id: 91, inbox_id: 12, conversation_id: 34 }; return { data: existing }; } },
    '@figuro/chatwoot-sdk': {}, '@figuro/chatwoot-sdk/dist/core/request': {},
  });
  const portal = Object.create(ChatwootService.prototype);
  portal.provider = { accountId: 12, token: 'synthetic', url: 'https://portal.local.invalid' };
  portal.clientCw = async () => ({ messages: { create: async args => {
    calls.creates.push(args); existing = { id: 91, inbox_id: 12, conversation_id: 34 }; if (options.afterCreateError) throw new Error('ambiguous accepted POST'); return options.partialAck ? { id: existing.id } : existing;
  } } });
  portal.isImportHistoryAvailable = () => true;
  portal.waMonitor = { waInstances: { 'local-a': { instanceId: 'instance-local-a', getBase64FromMediaMessage: async () => ({ base64: 'c3ludGhldGlj', mimetype: 'image/jpeg' }) } } };
  portal.configService = { get: () => ({}) };
  portal.logger = { error() {}, warn() {} };
  portal.createConversation = async () => 34;
  portal.getInbox = async () => ({ id: 12 });
  const body = { key: { id: 'wamid.LOCAL.echo.1', fromMe: true, remoteJid: '15550000002@s.whatsapp.net' },
    message: { conversation: 'Synthetic app reply' }, messageType: 'conversation', messageTimestamp: 1795500000 };
  return { portal, body, calls };
}

test('real Portal echo adapter uses outgoing + WAID guard and reconciles duplicates before POST', async () => {
  const h = portalHarness(); const instance = { instanceName: 'local-a', instanceId: 'instance-local-a' };
  await h.portal.mirrorBusinessAppEcho(instance, h.body);
  await h.portal.mirrorBusinessAppEcho(instance, h.body);
  assert.equal(h.calls.creates.length, 1);
  assert.equal(h.calls.creates[0].data.message_type, 'outgoing');
  assert.equal(h.calls.creates[0].data.source_id, 'WAID:wamid.LOCAL.echo.1');
  assert.equal(h.calls.creates[0].data.private, false);
});

test('Portal adapter requires reconciliation support and positive acknowledgment', async () => {
  const h = portalHarness(); h.portal.isImportHistoryAvailable = () => false;
  await assert.rejects(h.portal.mirrorBusinessAppEcho({ instanceName: 'local-a' }, h.body), /reconcil|dedup/i);
  const b = portalHarness(); b.portal.clientCw = async () => ({ messages: { create: async () => null } });
  await assert.rejects(b.portal.mirrorBusinessAppEcho({ instanceName: 'local-a' }, b.body), /acknowledg|empty/i);
});

test('MetaController awaits and routes each change only to its bound instance', async () => {
  const { MetaController } = load('src/api/integrations/channel/meta/meta.controller.ts');
  const delivered = [];
  const instances = { a: { connectToWhatsapp: async p => delivered.push(['a', p]) }, b: { connectToWhatsapp: async p => delivered.push(['b', p]) } };
  const controller = new MetaController({ instance: { findFirst: async ({ where }) => ({ name: where.number === 'phone-local-a' ? 'a' : 'b' }) } }, { waInstances: instances });
  const p = fixture('echo-text'); const b = copy(p.entry[0].changes[0]); b.value.metadata.phone_number_id = 'phone-local-b'; p.entry[0].changes.push(b);
  await controller.receiveWebhook(p);
  assert.equal(delivered.length, 2);
  for (const [name, packet] of delivered) {
    assert.equal(packet.entry.length, 1); assert.equal(packet.entry[0].changes.length, 1);
    assert.equal(value(packet).metadata.phone_number_id, name === 'a' ? 'phone-local-a' : 'phone-local-b');
  }
  instances.a.connectToWhatsapp = async () => { throw new Error('pause unavailable'); };
  await assert.rejects(controller.receiveWebhook(fixture('echo-text')), /pause unavailable/);
});


test('retry after Portal success and final DB failure reconciles the accepted source id', async () => {
  const h = harness({ finalPersistError: true }); const portal = portalHarness();
  h.service.chatwootService = portal.portal;
  await assert.rejects(h.service.connectToWhatsapp(fixture('echo-text')), /persist final unavailable/);
  assert.equal(portal.calls.creates.length, 1);
  h.options.finalPersistError = false;
  // A new channel object models process restart; durable rows and Portal state remain.
  const restarted = harness({ records: h.records }); restarted.service.chatwootService = portal.portal;
  await restarted.service.connectToWhatsapp(fixture('echo-text'));
  assert.equal(portal.calls.creates.length, 1);
  assert.equal([...h.records.values()][0].status, 'COEXISTENCE_ECHO_DONE');
});

test('durable duplicate collision fails even after completion, and JSONB key order is irrelevant', async () => {
  const h = harness(); const p = fixture('echo-text'); await h.service.connectToWhatsapp(p);
  const record = [...h.records.values()][0]; record.key = { fromMe: true, remoteJid: record.key.remoteJid, id: record.key.id };
  await h.service.connectToWhatsapp(p);
  value(p).message_echoes[0].text.body = 'Different synthetic content';
  await assert.rejects(h.service.connectToWhatsapp(p), /collision/);
  assert.equal(h.calls.portal.length, 1);
});

test('official media shape is persisted as outgoing without inbound lead/bot creation', async () => {
  for (const type of ['image', 'video', 'document', 'audio', 'sticker']) {
    const h = harness(); const p = fixture('echo-text'); const echo = value(p).message_echoes[0];
    echo.type = type; delete echo.text; echo[type] = { id: 'media-local', mime_type: type === 'document' ? 'application/pdf' : type + '/local' };
    await h.service.connectToWhatsapp(p);
    assert.equal(h.calls.portal[0][1].messageType, type + 'Message');
    assert.equal(h.calls.portal[0][1].message[type + 'Message'].id, 'media-local');
    assert.equal(h.calls.bots.length + h.calls.contacts.length, 0);
  }
});

test('revoke/edit are explicit thread notices preserving original id, no replay to WhatsApp/bot', async () => {
  for (const type of ['revoke', 'edit']) {
    const h = harness(); const p = fixture('echo-text'); const echo = value(p).message_echoes[0];
    echo.type = type; delete echo.text; echo[type] = { original_message_id: 'wamid.LOCAL.original' };
    if (type === 'edit') echo.edit.message = { type: 'image', image: { id: 'media-local', caption: 'Updated synthetic caption' } };
    await h.service.connectToWhatsapp(p);
    const msg = h.calls.portal[0][1];
    assert.equal(msg.contextInfo.originalMessageId, 'wamid.LOCAL.original');
    assert.match(msg.message.conversation, type === 'revoke' ? /excluída/ : /Editada/);
    assert.equal(h.calls.bots.length, 0);
  }
});

test('missing Portal configuration never records a completed echo even with no native session', async () => {
  const h = harness({ chatwoot: false, sessions: 0 });
  await assert.rejects(h.service.connectToWhatsapp(fixture('echo-text')), /Portal/);
  assert.notEqual([...h.records.values()][0]?.status, 'COEXISTENCE_ECHO_DONE');
});


test('real Portal media adapter posts attachment with WAID/outgoing, deduplicates after retry', async () => {
  const h = portalHarness(); h.body.messageType = 'imageMessage'; h.body.message = { imageMessage: { id: 'media-local', mime_type: 'image/jpeg' } };
  const instance = { instanceName: 'local-a', instanceId: 'instance-local-a' };
  await h.portal.mirrorBusinessAppEcho(instance, h.body); await h.portal.mirrorBusinessAppEcho(instance, h.body);
  assert.equal(h.calls.media.length, 1); assert.equal(h.calls.creates.length, 0);
  const fields = h.calls.media[0].data.fields;
  assert.equal(fields.find(x => x[0] === 'message_type')[1], 'outgoing');
  assert.equal(fields.find(x => x[0] === 'source_id')[1], 'WAID:wamid.LOCAL.echo.1');
  assert.ok(fields.some(x => x[0] === 'attachments[]'));
});

test('real Portal receiveWebhook WAID guard does not echo the reflected message back to WhatsApp', async () => {
  const h = portalHarness();
  const response = await h.portal.receiveWebhook({ instanceName: 'local-a' }, {
    event: 'message_created', message_type: 'outgoing', content: 'Synthetic app reply',
    conversation: { id: 34, meta: { sender: { identifier: '15550000002@s.whatsapp.net' } },
      messages: [{ source_id: 'WAID:wamid.LOCAL.echo.1' }] },
  });
  assert.equal(response.message, 'bot');
  assert.equal(h.calls.creates.length + h.calls.media.length, 0);
});

test('real native bot process ignores the next inbound when echo paused its existing session', async () => {
  const h = harness(); const session = { status: 'opened' };
  h.service.prismaRepository.integrationSession.updateMany = async ({ where, data }) => {
    assert.equal(where.instanceId, 'instance-local-a'); assert.equal(where.remoteJid, '15550000002@s.whatsapp.net');
    session.status = data.status; return { count: 1 };
  };
  await h.service.connectToWhatsapp(fixture('echo-text'));
  const { BaseChatbotService } = load('src/api/integrations/chatbot/base-chatbot.service.ts');
  const bot = Object.create(BaseChatbotService.prototype);
  bot.initNewSession = async () => assert.fail('echo must not cause session initialization');
  bot.logger = { error: err => assert.fail(String(err)) };
  await bot.process({ instanceName: 'local-a' }, '15550000002@s.whatsapp.net', {}, session, {}, 'Next inbound');
  assert.equal(session.status, 'paused');
});


test('transport status changes cannot reopen a completed echo or repeat the human pause', async () => {
  const h = harness(); await h.service.connectToWhatsapp(fixture('echo-text'));
  const record = [...h.records.values()][0]; record.status = 'DELIVERED';
  const p = fixture('status-delivered'); value(p).statuses[0].id = record.key.id;
  await h.service.connectToWhatsapp(p); await h.service.connectToWhatsapp(fixture('echo-text'));
  assert.equal(h.calls.pause.length, 1); assert.equal(h.calls.portal.length, 1);
  assert.equal(record.contextInfo.coexistenceEchoDelivered, true);
});


test('every Portal acknowledgment path resolves inbox/conversation, including ambiguous accepted POST', async () => {
  for (const options of [{ partialAck: true }, { partialAck: true, afterCreateError: true }]) {
    const h = portalHarness(options); const instance = { instanceName: 'local-a' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await h.portal.mirrorBusinessAppEcho(instance, h.body);
      assert.equal(response.id, 91); assert.equal(response.inbox_id, 12); assert.equal(response.conversation_id, 34);
    }
    assert.equal(h.calls.creates.length, 1);
  }
});

test('real Business media downloader reads media through GET only and keeps the app echo outgoing', async () => {
  const h = harness(); const gets = [];
  // A separate module instance provides an isolated HTTP boundary for this actual method.
  const { BusinessStartupService } = load('src/api/integrations/channel/meta/whatsapp.business.service.ts', {
    axios: { get: async (url, config) => { gets.push({ url, config });
      return gets.length === 1 ? { data: { url: 'https://media.local.invalid/asset' } } : { data: Buffer.from('synthetic') };
    } },
  });
  const service = Object.create(BusinessStartupService.prototype);
  service.configService = { get: () => ({ URL: 'https://graph.local.invalid', VERSION: 'v-local' }) };
  service.token = 'synthetic'; service.logger = { error: e => assert.fail(String(e)) };
  const result = await service.getBase64FromMediaMessage({ message: { key: { fromMe: true }, messageType: 'imageMessage', message: {
    imageMessage: { id: 'media-local', mime_type: 'image/jpeg' },
  } } });
  assert.equal(gets.length, 2); assert.equal(gets[0].url, 'https://graph.local.invalid/v-local/media-local');
  assert.equal(result.base64, Buffer.from('synthetic').toString('base64')); assert.equal(result.mimetype, 'image/jpeg');
  assert.equal(h.calls.bots.length, 0);
});

function signedRouterHarness(config = {}) {
  const h = harness();
  const { MetaController } = load('src/api/integrations/channel/meta/meta.controller.ts');
  const controller = new MetaController({ instance: { findFirst: async () => ({ name: 'local-a' }) } }, { waInstances: { 'local-a': h.service } });
  const routes = {};
  const fakeRouter = { get(route, handler) { routes['GET ' + route] = handler; return this; }, post(route, ...handlers) { routes['POST ' + route] = handlers; return this; } };
  const helper = 'src/api/integrations/channel/meta/meta-webhook-security.ts';
  const security = fs.existsSync(path.join(__dirname, '..', helper)) ? load(helper) : {};
  const { MetaRouter } = load('src/api/integrations/channel/meta/meta.router.ts', {
    '@api/abstract/abstract.router': { RouterBroker: class { routerPath(route) { return '/' + route; } } },
    '@api/server.module': { metaController: controller }, express: { Router: () => fakeRouter },
    './meta-webhook-security': security,
  });
  new MetaRouter({ get: () => ({ APP_SECRET: 'synthetic-app-secret', ...config }) });
  return { ...h, security, async post(body, raw, signature) {
    const req = { body, metaRawBody: raw, headers: { 'x-hub-signature-256': signature }, ip: '127.0.0.1', app: { get: () => false } };
    return new Promise((resolve, reject) => {
      const res = { code: 200, headers: {}, status(code) { this.code = code; return this; },
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, getHeader(name) { return this.headers[name.toLowerCase()]; },
        json(body) { this.body = body; resolve(this); return this; }, send(body) { return this.json(body); } };
      const handlers = routes['POST /webhook/meta'];
      const dispatch = index => {
        try {
          const result = handlers[index](req, res, error => error ? reject(error) : dispatch(index + 1));
          if (result?.catch) result.catch(reject);
        } catch (error) { reject(error); }
      };
      dispatch(0);
    });
  } };
}

test('actual Meta route authenticates raw-byte signatures before any coexistence effect', async () => {
  const { createHmac } = require('node:crypto'); const body = fixture('echo-text');
  const raw = Buffer.from(JSON.stringify(body, null, 2) + '\n');
  const signature = 'sha256=' + createHmac('sha256', 'synthetic-app-secret').update(raw).digest('hex');
  const valid = signedRouterHarness(); assert.equal((await valid.post(body, raw, signature)).code, 200);
  assert.equal(valid.calls.pause.length, 1); assert.equal(valid.calls.portal.length, 1);
  for (const [bytes, header] of [[raw, undefined], [raw, 'sha256=' + '0'.repeat(64)], [Buffer.from(raw.toString().replace('Synthetic app reply', 'Altered reply')), signature], [undefined, signature]]) {
    const h = signedRouterHarness(); const result = await h.post(body, bytes, header);
    assert.equal(result.code, 403); assert.equal(h.records.size + h.calls.pause.length + h.calls.portal.length, 0);
  }
  const noSecret = signedRouterHarness({ APP_SECRET: '' });
  assert.equal((await noSecret.post(body, raw, signature)).code, 503);
  assert.equal(noSecret.records.size + noSecret.calls.pause.length + noSecret.calls.portal.length, 0);
});

test('raw capture keeps exact bytes solely for Meta, including query and trailing slash', () => {
  const { captureMetaRawBody } = load('src/api/integrations/channel/meta/meta-webhook-security.ts');
  const raw = Buffer.from(' { "synthetic": true }\n');
  for (const url of ['/webhook/meta', '/webhook/meta/?query=synthetic']) {
    const request = { url }; captureMetaRawBody(request, {}, raw);
    assert.equal(request.metaRawBody.toString(), raw.toString()); assert.notEqual(request.metaRawBody, raw);
  }
  const unrelated = { url: '/message/sendText/local' }; captureMetaRawBody(unrelated, {}, raw);
  assert.equal(unrelated.metaRawBody, undefined);
});

test('legacy unsigned traffic is explicit compatibility only; configured secret validates all POSTs', async () => {
  const p = fixture('inbound-text'); const raw = Buffer.from(JSON.stringify(p));
  const legacy = signedRouterHarness({ APP_SECRET: '', ALLOW_UNSIGNED_LEGACY: true });
  assert.equal((await legacy.post(p, raw, undefined)).code, 200);
  const strict = signedRouterHarness({ APP_SECRET: '', ALLOW_UNSIGNED_LEGACY: false });
  assert.equal((await strict.post(p, raw, undefined)).code, 503);
  const configured = signedRouterHarness(); assert.equal((await configured.post(p, raw, undefined)).code, 403);
});

test('history media follow-ups and state sync cannot enter live inbound before durable sync is implemented', async () => {
  for (const field of ['history', 'smb_app_state_sync']) {
    const h = harness(); const p = fixture('inbound-text'); p.entry[0].changes[0].field = field;
    await assert.rejects(h.service.connectToWhatsapp(p), /durable.*ingest.*unavailable/i);
    assert.equal(h.records.size + h.calls.bots.length + h.calls.pause.length + h.calls.portal.length, 0);
  }
});

test('Cloud PN identity is exact and consistent across echo pause, next inbound, contacts and statuses (BR/MX/AR)', async () => {
  const { createJid } = load('src/utils/createJid.ts');
  for (const phone of ['5531990000000', '5215500000000', '5491100000000']) {
    const h = harness(); const expected = phone + '@s.whatsapp.net';
    assert.notEqual(createJid(phone), expected, 'control must exercise an actual country heuristic');
    const echo = fixture('echo-text'); value(echo).message_echoes[0].to = phone; value(echo).contacts[0].wa_id = phone;
    await h.service.connectToWhatsapp(echo);
    const inbound = fixture('inbound-text'); value(inbound).messages[0].from = phone; value(inbound).contacts[0].wa_id = phone;
    await h.service.connectToWhatsapp(inbound);
    assert.equal(h.calls.pause[0].body.remoteJid, expected);
    assert.equal(h.calls.bots[0].remoteJid, expected);
    assert.equal(h.calls.contacts[0].data.remoteJid, expected);
    const status = fixture('status-delivered'); value(status).statuses[0].id = value(echo).message_echoes[0].id;
    value(status).statuses[0].recipient_id = phone;
    await h.service.connectToWhatsapp(status);
    assert.equal(h.calls.updates.at(-1).data.remoteJid, expected);
  }
});


test('actual Meta route rate-limits before HMAC/side effects with Retry-After and recovers after the window', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const h = signedRouterHarness({ WEBHOOK_RATE_LIMIT: 1, WEBHOOK_RATE_WINDOW_MS: 1000 });
  const body = fixture('echo-text'); const raw = Buffer.from(JSON.stringify(body));
  assert.equal((await h.post(body, raw, undefined)).code, 403);
  const limited = await h.post(body, raw, undefined);
  assert.equal(limited.code, 429); assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(h.records.size + h.calls.pause.length + h.calls.portal.length, 0);
  t.mock.timers.tick(1001);
  assert.equal((await h.post(body, raw, undefined)).code, 403);
});
