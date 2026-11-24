const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs, loadRecoveryMethod } = require('./support/xmacna-inbound-runtime.cjs');
const { resolveInboundAddress, UnresolvedInboundLidError } = loadTs(
  'src/api/integrations/channel/whatsapp/inboundIdentity.ts',
);
const { dispatchInboundChatbot, attemptDurableInboundSink } = loadTs(
  'src/api/integrations/channel/whatsapp/inboundSinkDispatch.ts',
);
const lid = '900000000000000000000001@lid';
const phone = '90000000000000000000@s.whatsapp.net';
const event = { event: 'unresolved_inbound_lid_delivered_as_lid', mode: 'enforce', sink: 'chatbot' };
const aliases = (find = async () => null) => ({ find, confirm: async (_scope, _lid, pn) => pn });

for (const mode of [undefined, 'off', 'shadow', 'enforce']) {
  test(`dispatch ${mode}: unresolved LID reaches durable delivery`, async () => {
    const key = { remoteJid: lid };
    const marks = [], calls = [], logs = [], persisted = [];
    let unresolved;
    try { await resolveInboundAddress('synthetic-instance', key, aliases(), async () => null); }
    catch (error) { assert.ok(error instanceof UnresolvedInboundLidError); unresolved = error; }
    await dispatchInboundChatbot({
      messageKey: key, unresolvedLid: unresolved, receiptMode: mode,
      attempt: async (operation) => !(await attemptDurableInboundSink({
        sink: 'chatbot', operation, mark: async (sink, state) => {
          marks.push([sink, state]); persisted.push({ ...key });
        },
      })),
      durable: async () => {
        assert.equal(key.remoteJid, lid);
        assert.equal(key.senderLid, mode === 'enforce' ? lid : undefined);
        calls.push('durable');
      },
      bestEffort: async () => { calls.push('best-effort'); },
      onUnresolvedLidDelivered: () => { logs.push(event); },
    });
    assert.deepEqual(marks, [['chatbot', 'sent']]);
    assert.deepEqual(calls, ['durable', 'best-effort']);
    assert.deepEqual(persisted, [mode === 'enforce' ? { remoteJid: lid, senderLid: lid } : { remoteJid: lid }]);
    assert.deepEqual(logs, mode === 'enforce' ? [event] : []);
  });
}

function recovery(options = {}) {
  const marks = [], calls = [], logs = [], failures = [], persisted = [];
  const key = { remoteJid: lid, ...options.initialKey };
  const context = {
    instance: { name: 'synthetic-instance' }, instanceId: 'synthetic-instance-id',
    lidPhoneAliases: aliases(options.find),
    client: { signalRepository: { lidMapping: { getPNForLID: options.mapping || (async () => null) } } },
    configService: { get: () => ({ ENABLED: false }) },
    logger: { warn: (value) => logs.push(JSON.parse(value)), error: () => {} },
    inboundInbox: {
      heartbeat: async () => true,
      markSink: async (_id, sink, state, _owner, _token, msg) => {
        marks.push([sink, state]);
        if (state === 'sent') assert.equal(msg.key.remoteJid, options.expectedJid || lid);
        if (options.fenced) return false;
        persisted.push(JSON.parse(JSON.stringify(msg)));
        return true;
      },
      markDone: async () => { calls.push('done'); return true; },
      markFailed: async (_id, _owner, _token, error) => { failures.push(error); return true; },
    },
  };
  const method = loadRecoveryMethod({
    attemptDurableInboundSink, resolveInboundAddress, UnresolvedInboundLidError,
    Events: { MESSAGES_UPSERT: 'messages.upsert' },
    chatbotController: {
      emitDurableInbound: async (payload) => {
        calls.push('durable');
        assert.equal(payload.remoteJid, options.expectedJid || lid);
        assert.equal(payload.msg.key.senderLid, lid);
        if (options.deliveryFailure) throw new Error('synthetic transport unavailable');
      },
      emitBestEffortInbound: async () => { calls.push('best-effort'); },
    },
  });
  return {
    marks, calls, logs, failures, key, persisted,
    run: () => method.call(context, {
      receiptId: 'synthetic-receipt', leaseOwner: 'synthetic-owner', leaseToken: 1,
      webhookState: 'sent', chatwootState: 'sent', chatbotState: options.settled ? 'sent' : 'failed',
      message: { key },
    }, { LEASE_SECONDS: 60, MAX_ATTEMPTS: 10 }),
  };
}

test('real recovery method: unknown LID is marked sent and receipt completes', async () => {
  const run = recovery(); await run.run();
  assert.deepEqual(run.marks, [['chatbot', 'sent']]);
  assert.deepEqual(run.calls, ['durable', 'best-effort', 'done']);
  assert.deepEqual(run.failures, []);
  assert.equal(run.key.remoteJid, lid); assert.equal(run.key.senderLid, lid);
  assert.deepEqual(run.logs, [event]);
  assert.deepEqual(run.persisted, [{ key: { remoteJid: lid, senderLid: lid } }]);
});

test('real recovery method: confirmed alias retains phone routing', async () => {
  const run = recovery({ find: async () => phone, expectedJid: phone }); await run.run();
  assert.deepEqual(run.marks, [['chatbot', 'sent']]);
  assert.deepEqual(run.calls, ['durable', 'best-effort', 'done']);
  assert.deepEqual(run.failures, []); assert.deepEqual(run.logs, []);
  assert.equal(run.key.remoteJid, phone); assert.equal(run.key.senderLid, lid);
  assert.deepEqual(run.persisted, [{ key: { remoteJid: phone, remoteJidAlt: phone, senderLid: lid } }]);
});

test('real recovery method: conflicting alias preserves LID without choosing a phone', async () => {
  const run = recovery({ find: async () => { throw new UnresolvedInboundLidError('ambiguous'); } });
  await run.run(); assert.deepEqual(run.marks, [['chatbot', 'sent']]);
  assert.deepEqual(run.calls, ['durable', 'best-effort', 'done']);
  assert.deepEqual(run.failures, []); assert.deepEqual(run.logs, [event]);
});

for (const dependency of ['find', 'mapping']) {
  test(`real recovery method: unexpected ${dependency} failure remains retryable`, async () => {
    const run = recovery({ [dependency]: async () => { throw new Error('synthetic dependency unavailable'); } });
    await run.run(); assert.deepEqual(run.marks, [['chatbot', 'failed']]);
    assert.deepEqual(run.calls, []); assert.equal(run.failures.length, 1);
    assert.deepEqual(run.logs, []);
  });
}

test('real recovery method: durable failure never runs best-effort or completes receipt', async () => {
  const run = recovery({ deliveryFailure: true }); await run.run();
  assert.deepEqual(run.marks, [['chatbot', 'failed']]);
  assert.deepEqual(run.calls, ['durable']); assert.equal(run.failures.length, 1);
  assert.deepEqual(run.logs, []);
});

test('real recovery method: fencing failure cannot complete the receipt', async () => {
  const run = recovery({ fenced: true }); await run.run();
  assert.deepEqual(run.marks, [['chatbot', 'sent']]);
  assert.deepEqual(run.calls, ['durable']); assert.equal(run.failures.length, 1);
  assert.deepEqual(run.logs, []);
});

test('real recovery method: already sent chatbot is not delivered again', async () => {
  const run = recovery({ settled: true }); await run.run();
  assert.deepEqual(run.marks, []); assert.deepEqual(run.calls, ['done']);
  assert.deepEqual(run.failures, []); assert.deepEqual(run.logs, []);
});

test('real recovery method: unresolved fallback preserves the alternate hint', async () => {
  const run = recovery({ initialKey: { remoteJidAlt: 'synthetic-unconfirmed' } });
  await run.run();
  assert.deepEqual(run.calls, ['durable', 'best-effort', 'done']);
  assert.deepEqual(run.persisted, [{ key: {
    remoteJid: lid, remoteJidAlt: 'synthetic-unconfirmed', senderLid: lid,
  } }]);
});

test('dispatch: resolved identity keeps the phone and does not log fallback', async () => {
  const key = { remoteJid: phone, senderLid: lid };
  const calls = [];
  await dispatchInboundChatbot({
    messageKey: key, receiptMode: 'enforce',
    attempt: async (operation) => { await operation(); return true; },
    durable: async () => { assert.equal(key.remoteJid, phone); calls.push('durable'); },
    bestEffort: async () => { calls.push('best-effort'); },
    onUnresolvedLidDelivered: () => { assert.fail('resolved identity must not log fallback'); },
  });
  assert.deepEqual(calls, ['durable', 'best-effort']);
});

test('dispatch: failed delivery keeps the receipt failed without success logging or best-effort', async () => {
  const marks = [];
  await dispatchInboundChatbot({
    messageKey: { remoteJid: lid }, receiptMode: 'enforce', unresolvedLid: new UnresolvedInboundLidError('unknown'),
    attempt: async (operation) => !(await attemptDurableInboundSink({
      sink: 'chatbot', operation, mark: async (sink, state) => { marks.push([sink, state]); },
    })),
    durable: async () => { throw new Error('synthetic transport unavailable'); },
    bestEffort: async () => { assert.fail('failed durable delivery must not run best-effort'); },
    onUnresolvedLidDelivered: () => { assert.fail('failed delivery must not log success'); },
  });
  assert.deepEqual(marks, [['chatbot', 'failed']]);
});
