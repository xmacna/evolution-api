const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { transformSync } = require('esbuild');

function syncClass() {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/api/integrations/channel/meta/business-app-sync.ts'),
    'utf8',
  );
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'node24' }).code, {
    module,
    exports: module.exports,
    Buffer,
    URL,
    require(name) {
      if (name === 'crypto') return require(name);
      throw new Error('Unexpected sync boundary ' + name);
    },
  });
  return module.exports.BusinessAppSync;
}
const digest = (s) => createHash('sha256').update(s).digest('hex');
const binding = {
  instanceId: 'sync-local-a',
  instanceName: 'sync-a',
  phoneNumberId: 'phone-local-a',
  messagingAccountId: 'account-local-a',
};
const registration = {
  phoneNumberId: binding.phoneNumberId,
  messagingAccountId: binding.messagingAccountId,
  generation: digest(binding.messagingAccountId + ':' + binding.phoneNumberId),
  onboardedAt: '2026-11-24T12:00:00.000Z',
  deadline: '2026-11-25T12:00:00.000Z',
};
const metadata = { phone_number_id: binding.phoneNumberId, display_phone_number: '15550000001' };
const history = (progress) => ({
  metadata: { ...metadata },
  history: [
    {
      metadata: { phase: 2, chunk_order: 1, progress },
      threads: [
        {
          id: '15550000002',
          context: { wa_id: '15550000002', user_id: 'US.SYNTHETIC.2' },
          messages: [
            {
              id: 'wamid.LOCAL.history.1',
              from: '15550000002',
              from_user_id: 'US.SYNTHETIC.2',
              timestamp: '1795521600',
              type: 'text',
              text: { body: 'Synthetic historical message' },
              history_context: { status: 'READ' },
            },
          ],
        },
      ],
    },
  ],
});

// Repository boundary only; all capture/lease/cursor/recovery logic is production code.
const { memoryRepository } = require('./helpers/meta-sync-repository.cjs');
function harness(options = {}) {
  const repository = options.repository || memoryRepository();
  const calls = [];
  let now = Date.parse('2026-11-24T13:00:00.000Z');
  const Service = syncClass();
  const make = () =>
    new Service(
      repository,
      options.binding || binding,
      {
        enabled: true,
        appSecretConfigured: true,
        callbackUrl: 'https://evolution.local.invalid/webhook/meta',
        destination: async () => ({
          portalAccountId: 11,
          portalInboxId: 22,
          portalBaseUrl: 'https://portal.local.invalid',
        }),
        clock: () => now,
        ...options,
      },
      async (run, unit) => {
        calls.push({ run, unit });
        if (options.projectHook) await options.projectHook();
        if (options.projectError) throw new Error('synthetic projection failure');
        return options.blocked ? { blocked: options.blocked } : {};
      },
    );
  return {
    repository,
    calls,
    options,
    service: make(),
    restart: make,
    advance: (ms) => {
      now += ms;
    },
  };
}

test('readiness reports actual binding and receiver fields but no import completion', async () => {
  const h = harness();
  const status = await h.service.status();
  assert.equal(status.ready, true);
  assert.equal(status.phoneNumberId, binding.phoneNumberId);
  assert.equal(status.messagingAccountId, binding.messagingAccountId);
  assert.equal(status.webhookCallbackUrl, 'https://evolution.local.invalid/webhook/meta');
  assert.deepEqual(Array.from(status.fields), ['history', 'smb_app_state_sync']);
  assert.equal(status.generation, null);
  const off = harness({ enabled: false });
  assert.equal((await off.service.status()).ready, false);
});

test('registration is idempotent, conserves its original deadline and binds request metadata once', async () => {
  const h = harness();
  await h.service.start(registration);
  const ack = await h.service.start({ ...registration, contactsRequestId: 'request-local-contacts' });
  assert.equal(ack.ok, true);
  assert.equal(ack.generation, registration.generation);
  assert.equal(h.repository.tables.run.size, 1);
  await assert.rejects(h.service.start({ ...registration, deadline: '2026-11-26T12:00:00.000Z' }), /deadline/);
  await assert.rejects(
    h.service.start({ ...registration, contactsRequestId: 'different-local-request' }),
    /request|metadata/i,
  );
  await assert.rejects(h.service.start({ ...registration, phoneNumberId: 'foreign-phone' }), /binding/);
});

test('capture persists an immutable payload before processing; restart resumes it, duplicate capture stays one chunk', async () => {
  const h = harness();
  await h.service.start(registration);
  const payload = history(55);
  const ack = await h.service.capture('history', payload, binding.messagingAccountId);
  assert.equal(ack.captured, true);
  assert.equal(h.calls.length, 0);
  payload.history[0].threads[0].messages[0].text.body = 'Changed caller object';
  const saved = [...h.repository.tables.chunk.values()][0];
  assert.equal(saved.payload.value.history[0].threads[0].messages[0].text.body, 'Synthetic historical message');
  await h.service.capture('history', history(55), binding.messagingAccountId);
  assert.equal(h.repository.tables.chunk.size, 1);
  const restarted = h.restart();
  await restarted.drain();
  assert.equal(h.calls.length, 1);
  assert.equal(saved.state, 'done');
  await restarted.drain();
  assert.equal(h.calls.length, 1);
});

test('capture errors cannot be acknowledged and foreign tenants cannot share captured work', async () => {
  const h = harness();
  await h.service.start(registration);
  await assert.rejects(h.service.capture('history', history(55), 'foreign-account'), /binding/);
  await assert.rejects(h.service.capture('history', history(55), undefined), /binding/);
  h.repository.businessAppSyncChunk.create = async () => {
    throw new Error('synthetic durable write failure');
  };
  await assert.rejects(h.service.capture('history', history(55), binding.messagingAccountId), /durable write failure/);
  assert.equal(h.calls.length, 0);
});

test('source progress100 and phase2 are distinct from local processing and contact source completion', async () => {
  const h = harness();
  await h.service.start(registration);
  await h.service.capture('history', history(100), binding.messagingAccountId);
  let status = await h.service.status();
  assert.equal(status.history.sourceProgress, 100);
  assert.equal(status.history.importState, 'pending');
  await h.service.drain();
  status = await h.service.status();
  assert.equal(status.history.importState, 'caught_up');
  assert.equal(status.contacts.sourceCompletion, 'not_signaled');
  const partial = harness();
  await partial.service.start(registration);
  await partial.service.capture('history', history(55), binding.messagingAccountId);
  await partial.service.drain();
  assert.equal((await partial.service.status()).history.sourceProgress, 55);
});

test('lease expiry reclaims persisted cursor after a crash and concurrent drain claims only once', async () => {
  const h = harness();
  await h.service.start(registration);
  await h.service.capture('history', history(55), binding.messagingAccountId);
  const row = [...h.repository.tables.chunk.values()][0];
  row.state = 'processing';
  row.leaseOwner = 'crashed-worker';
  row.leaseExpiresAt = new Date('2026-11-24T12:00:00Z');
  await Promise.all([h.service.drain(), h.restart().drain()]);
  assert.equal(h.calls.length, 1);
  assert.equal(row.state, 'done');
  assert.equal(row.leaseVersion, 1);
});

test('projection failure remains retryable with the same durable payload across restart', async () => {
  const h = harness({ projectError: true });
  await h.service.start(registration);
  await h.service.capture('history', history(55), binding.messagingAccountId);
  await h.service.drain();
  const row = [...h.repository.tables.chunk.values()][0];
  assert.equal(row.state, 'pending');
  assert.equal(row.cursor, 0);
  h.options.projectError = false;
  h.advance(120000);
  await h.restart().drain();
  assert.equal(row.state, 'done');
  assert.equal(row.attempts, 2);
});

test('unsupported identity is explicit quarantined work, preserving raw data without fake phones', async () => {
  const h = harness({ blocked: 'BSUID_PHONE_UNAVAILABLE' });
  await h.service.start(registration);
  await h.service.capture('history', history(55), binding.messagingAccountId);
  await h.service.drain();
  const status = await h.service.status();
  assert.equal(status.history.importState, 'blocked');
  assert.equal(status.history.blockedChunks, 1);
  assert.ok([...h.repository.tables.chunk.values()][0].payload.value.history);
});

test('late payload is captured after deadline and remains visible for local completion', async () => {
  const h = harness();
  await h.service.start(registration);
  h.advance(48 * 3600000);
  await h.service.capture('history', history(100), binding.messagingAccountId);
  assert.equal([...h.repository.tables.chunk.values()][0].late, true);
  await h.service.drain();
  assert.equal((await h.service.status()).history.importState, 'caught_up');
});

test('history consent error and media follow-up retain the official shapes without live message dispatch', async () => {
  const h = harness();
  await h.service.start(registration);
  await h.service.capture(
    'history',
    { metadata, history: [{ errors: [{ code: 2593109, title: 'Synthetic declined history' }] }] },
    binding.messagingAccountId,
  );
  await h.service.drain();
  assert.equal((await h.service.status()).history.consent, 'declined');
  assert.equal(h.calls.length, 0);
  await h.service.capture(
    'history',
    {
      metadata,
      messages: [
        {
          id: 'wamid.LOCAL.history.media',
          from: '15550000002',
          from_user_id: 'US.SYNTHETIC.2',
          timestamp: '1795521600',
          type: 'image',
          image: { id: 'media-local', mime_type: 'image/jpeg' },
        },
      ],
    },
    binding.messagingAccountId,
  );
  await h.service.drain();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].unit.kind, 'message');
  assert.equal(h.calls[0].unit.message.image.id, 'media-local');
});

test('an expired worker cannot advance cursor or finish after its projection await', async () => {
  const h = harness();
  h.options.projectHook = () => h.advance(61000);
  await h.service.start(registration);
  await h.service.capture('history', history(55), binding.messagingAccountId);
  await h.service.drain();
  const row = [...h.repository.tables.chunk.values()][0];
  assert.equal(row.state, 'processing');
  assert.equal(row.cursor, 0);
  h.options.projectHook = undefined;
  await h.restart().drain();
  assert.equal(row.state, 'done');
  assert.equal(row.cursor, 1);
});

test('rebinding an instance cannot advertise or capture into a stale account/phone generation', async () => {
  const a = harness();
  await a.service.start(registration);
  const next = { ...binding, phoneNumberId: 'phone-local-b', messagingAccountId: 'account-local-b' };
  const b = harness({ repository: a.repository, binding: next });
  assert.equal((await b.service.status()).ready, false);
  const body = history(55);
  body.metadata.phone_number_id = next.phoneNumberId;
  await assert.rejects(b.service.capture('history', body, next.messagingAccountId), /binding/);
  assert.equal(a.repository.tables.chunk.size, 0);
});

test('a receiver rebound to another account cannot drain the earlier run', async () => {
  const a = harness();
  await a.service.start(registration);
  await a.service.capture('history', history(55), binding.messagingAccountId);
  const b = harness({
    repository: a.repository,
    binding: { ...binding, phoneNumberId: 'phone-local-b', messagingAccountId: 'account-local-b' },
  });
  await b.service.drain();
  assert.equal(b.calls.length, 0);
  assert.equal([...a.repository.tables.chunk.values()][0].state, 'pending');
});

test('Portal target rebind blocks readiness/projection but retains durable captures for original run', async () => {
  let destination = { portalAccountId: 11, portalInboxId: 22, portalBaseUrl: 'https://portal.local.invalid' };
  const h = harness({ destination: async () => destination });
  await h.service.start(registration);
  destination = { ...destination, portalInboxId: 99 };
  assert.equal((await h.service.status()).reason, 'stale_portal_destination');
  await h.service.capture('history', history(100), binding.messagingAccountId);
  await h.service.drain();
  assert.equal(h.calls.length, 0);
  assert.equal(h.repository.tables.chunk.size, 1);
  await assert.rejects(h.service.start(registration), /stale_portal_destination/);
});
