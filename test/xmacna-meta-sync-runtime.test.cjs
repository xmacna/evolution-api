const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { transformSync } = require('esbuild');
const { memoryRepository } = require('./helpers/meta-sync-repository.cjs');
function load(file, boundaries = {}) {
  const module = { exports: {} };
  vm.runInNewContext(
    transformSync(fs.readFileSync(path.join(__dirname, '../src/api/integrations/channel/meta/', file), 'utf8'), {
      loader: 'ts',
      format: 'cjs',
      target: 'node24',
    }).code,
    {
      module,
      exports: module.exports,
      URL,
      Buffer,
      setInterval: boundaries.timer || (() => ({ unref() {} })),
      clearInterval: () => {},
      require(name) {
        if (name === 'crypto') return require(name);
        if (name in boundaries) return boundaries[name];
        throw new Error('Unexpected runtime boundary ' + name);
      },
    },
  );
  return module.exports;
}
function harness(options = {}) {
  const repo = options.repo || memoryRepository();
  const calls = { messages: [], contacts: [], media: [], failures: 0, timers: [] };
  let provider = {
    enabled: true,
    token: 'synthetic-private',
    nameInbox: 'Synthetic Inbox',
    accountId: '11',
    url: 'https://portal.local.invalid',
  };
  let number = 'phone-local-a';
  repo.chatwoot = { findUnique: async () => provider };
  repo.instance = { findUnique: async () => ({ number }) };
  const pool = {
    async query(sql) {
      if (sql.includes('FROM inboxes')) return { rows: [{ id: options.inboxId || 22 }] };
      if (sql.includes('FROM access_tokens')) return { rows: [{ type: options.actorType || 'AgentBot', id: 33 }] };
      throw new Error('Unexpected SQL boundary');
    },
  };
  const sync = load('business-app-sync.ts');
  const boundary = {
    './business-app-sync': sync,
    '@api/integrations/chatbot/chatwoot/libs/postgres.client': {
      postgresClient: { getChatwootConnection: () => pool },
    },
    '@api/integrations/chatbot/chatwoot/business-app-history-guard': {
      inspectBusinessAppHistoryIndex: async () => ({ ready: options.indexReady !== false }),
    },
    '@api/integrations/chatbot/chatwoot/business-app-history-media': {
      attachBusinessAppHistoryMedia: async (...args) => {
        calls.media.push(args);
        await args[6]();
      },
    },
    '@api/integrations/chatbot/chatwoot/chatwootBusinessAppHistory': {
      importBusinessAppHistoryMessage: async (...args) => {
        calls.messages.push(args);
        return {
          id: 9,
          conversation_record_id: 101,
          conversation_display_id: 7,
          content_attributes: { business_app_history: true },
        };
      },
      importBusinessAppContact: async (...args) => calls.contacts.push(args),
    },
    axios: {
      post() {
        throw new Error('No Graph/write endpoint permitted in sync runtime');
      },
    },
    'mime-types': { extension: () => 'png' },
    timer: (fn) => {
      calls.timers.push(fn);
      return { unref() {} };
    },
  };
  const { BusinessAppSyncRuntime } = load('business-app-sync-runtime.ts', boundary);
  const binding = { instanceId: 'instance-local-a', instanceName: 'sync-local', number };
  const config = {
    get(key) {
      return key === 'WA_BUSINESS'
        ? {
            APP_SECRET: 'synthetic-app-secret',
            COEXISTENCE_SYNC_BINDINGS:
              options.bindings ||
              JSON.stringify({ 'sync-local': { phoneNumberId: number, messagingAccountId: 'account-local-a' } }),
            COEXISTENCE_SYNC_CALLBACK_URL: 'https://evolve.local.invalid/webhook/meta',
            COEXISTENCE_SYNC_PORTAL_URL: 'https://portal.local.invalid',
          }
        : { ENABLED: true, IMPORT: { DATABASE: { CONNECTION: { URI: 'synthetic-local' } } } };
    },
  };
  const make = () =>
    new BusinessAppSyncRuntime(
      repo,
      config,
      binding,
      async () => ({ base64: Buffer.from('synthetic').toString('base64') }),
      () => calls.failures++,
    );
  return {
    repo,
    calls,
    runtime: make(),
    restart: make,
    provider(value) {
      provider = { ...provider, ...value };
    },
    rebind(value) {
      number = value;
    },
  };
}
const start = {
  phoneNumberId: 'phone-local-a',
  messagingAccountId: 'account-local-a',
  generation: createHash('sha256').update('account-local-a:phone-local-a').digest('hex'),
  onboardedAt: '2026-11-24T00:00:00.000Z',
  deadline: '2026-11-25T00:00:00.000Z',
};
const metadata = { phone_number_id: 'phone-local-a', display_phone_number: '15550000001' };
function history(messages, context = { wa_id: '15550000002', user_id: 'US.SYNTHETIC.2' }) {
  return {
    metadata,
    history: [{ metadata: { progress: 100, phase: 2, chunk_order: 1 }, threads: [{ context, messages }] }],
  };
}
const incoming = {
  id: 'wamid.SYNTHETIC.inbound',
  type: 'text',
  from: '15550000002',
  from_user_id: 'US.SYNTHETIC.2',
  timestamp: '1795521600',
  text: { body: 'Synthetic inbound' },
};
test('runtime stays disabled by default/exact map mismatch; missing guard or unknown actor fail readiness', async () => {
  for (const options of [
    { bindings: '{}' },
    { bindings: '{"Sync-Local":{}}' },
    { indexReady: false },
    { actorType: 'Unknown' },
  ]) {
    const h = harness(options);
    assert.equal((await h.runtime.sync.status()).ready, false);
    assert.equal(h.calls.messages.length, 0);
    h.runtime.close();
  }
});
test('actual coordinator captures before projection, recovers from restart and preserves directions/actor', async () => {
  const h = harness();
  await h.runtime.sync.start(start);
  await h.runtime.sync.capture(
    'history',
    history([incoming, { ...incoming, id: 'wamid.SYNTHETIC.outbound', from: '15550000001', from_user_id: undefined }]),
    'account-local-a',
  );
  assert.equal(h.calls.messages.length, 0);
  const resumed = h.restart();
  await new Promise(setImmediate);
  await resumed.sync.drain();
  assert.equal(h.calls.messages.length, 2);
  assert.deepEqual(
    h.calls.messages.map((x) => x[2].fromMe),
    [false, true],
  );
  assert.equal(h.calls.messages[0][1].actorType, 'AgentBot');
  assert.equal((await resumed.sync.status()).history.importState, 'caught_up');
  assert.ok(h.calls.timers.length >= 2);
  h.runtime.close();
  resumed.close();
});
test('fresh destination source fences stop provider or phone rebind, with raw capture retained', async () => {
  const h = harness();
  await h.runtime.sync.start(start);
  await h.runtime.sync.capture('history', history([incoming]), 'account-local-a');
  h.provider({ accountId: '44' });
  assert.equal((await h.runtime.sync.status()).reason, 'stale_portal_destination');
  await h.runtime.sync.drain();
  assert.equal(h.calls.messages.length, 0);
  h.provider({ accountId: '11' });
  h.rebind('another-phone');
  await h.runtime.sync.drain();
  assert.equal(h.calls.messages.length, 0);
  assert.equal(h.repo.tables.chunk.size, 1);
  h.runtime.close();
});
test('official phone+BSUID pairing maps later media only within instance; opaque identity stays durable/blocked', async () => {
  const h = harness();
  await h.runtime.sync.start(start);
  await h.runtime.sync.capture('history', history([incoming]), 'account-local-a');
  await h.runtime.sync.drain();
  await h.runtime.sync.capture(
    'history',
    {
      metadata,
      messages: [
        { ...incoming, from: undefined, type: 'image', image: { id: 'media-synthetic', mime_type: 'image/png' } },
      ],
    },
    'account-local-a',
  );
  await h.runtime.sync.drain();
  assert.equal(h.calls.media.length, 1);
  assert.equal(h.calls.media[0][3].conversation_display_id, 7);
  await h.runtime.sync.capture(
    'history',
    history([{ ...incoming, id: 'wamid.SYNTHETIC.opaque', from: undefined, from_user_id: 'US.SYNTHETIC.NEW' }], {
      user_id: 'US.SYNTHETIC.NEW',
    }),
    'account-local-a',
  );
  await h.runtime.sync.drain();
  assert.equal((await h.runtime.sync.status()).history.blockedChunks, 1);
  assert.equal(h.calls.messages.length, 2);
  h.runtime.close();
});
test('contact tombstones are stored without deleting a Portal conversation or invoking a pause path', async () => {
  const h = harness();
  await h.runtime.sync.start(start);
  await h.runtime.sync.capture(
    'smb_app_state_sync',
    {
      metadata,
      state_sync: [
        {
          type: 'contact',
          action: 'remove',
          contact: { user_id: 'US.SYNTHETIC.2', phone_number: '15550000002' },
          metadata: { timestamp: '1795521600' },
        },
      ],
    },
    'account-local-a',
  );
  await h.runtime.sync.drain();
  assert.equal(h.calls.contacts.length, 1);
  assert.equal(h.calls.contacts[0][2].action, 'remove');
  h.runtime.close();
});
