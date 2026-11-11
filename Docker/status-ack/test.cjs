const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { transform, BASE_SHA, sha } = require('./patch.cjs');
const root = process.env.BAILEYS_AUDITED_ROOT;
if (!root) throw new Error('BAILEYS_AUDITED_ROOT must point to the audited, read-only rc14 dependency');
const original = fs.readFileSync(path.join(root, 'lib/Socket/messages-recv.js'), 'utf8');
function between(source, a, b) {
  assert.equal(source.split(a).length, 2);
  assert.equal(source.split(b).length, 2);
  return source.slice(source.indexOf(a), source.indexOf(b));
}
async function seam(source, shouldIgnoreJid = () => false) {
  const { makeOfflineNodeProcessor } = await import(
    pathToFileURL(path.join(root, 'lib/Utils/offline-node-processor.js'))
  );
  const { buildAckStanza } = await import(pathToFileURL(path.join(root, 'lib/Utils/stanza-ack.js')));
  const sent = [],
    errors = [],
    handled = [],
    callbacks = new Map();
  let fail = false;
  const progress = new EventEmitter();
  const context = {
    makeOfflineNodeProcessor,
    buildAckStanza,
    authState: { creds: { me: { id: 'test@s.whatsapp.net' } } },
    logger: { debug() {} },
    sendNode: async (node) => {
      if (fail) {
        fail = false;
        throw Error('network fixture');
      }
      sent.push(node);
    },
    ev: { buffer() {}, flush() {} },
    onUnexpectedError: (error, label) => errors.push(label),
    ws: { isOpen: true, on: (name, fn) => callbacks.set(name, fn) },
    setImmediate,
    shouldIgnoreJid,
    S_WHATSAPP_NET: 's.whatsapp.net',
    NACK_REASONS: { UnhandledError: 500 },
    handleMessage: async (node) => {
      handled.push(node.attrs.id);
      progress.emit('message:' + node.attrs.id);
    },
    handleCall: async () => {},
    handleReceipt: async () => {},
    handleNotification: async () => {},
  };
  // Run the actual dependency's ack function, routing/queue block and registrations.
  // External socket I/O is stubbed; the real queue and ACK builder are imported unchanged.
  const ack = between(source, '    const sendMessageAck =', '    const rejectCall =');
  const routing = between(source, '    const processNodeWithBuffer =', "    ws.on('CB:ack,class:message'");
  vm.runInNewContext(ack + '\n' + routing, context);
  return {
    callbacks,
    sent,
    errors,
    handled,
    progress,
    failNext: () => {
      fail = true;
    },
  };
}
const candidate = process.env.STATUS_ACK_TEST_BASELINE === '1' ? original : transform(original);
const stanza = (id, offline) => ({
  tag: 'status',
  attrs: {
    id,
    from: 'status@broadcast',
    type: 'media',
    participant: 'peer@s.whatsapp.net',
    ...(offline ? { offline: 'true' } : {}),
  },
});
test('RED seam: audited baseline has no native Status handler', async () => {
  assert.equal(sha(original), BASE_SHA);
  const before = await seam(original);
  assert.equal(before.callbacks.has('CB:status'), false);
});
test('live Status uses real ACK builder; no error/NACK, no bot message', async () => {
  const s = await seam(candidate);
  await s.callbacks.get('CB:status')(stanza('live'));
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].tag, 'ack');
  assert.equal(s.sent[0].attrs.class, 'status');
  assert.equal(s.sent[0].attrs.id, 'live');
  assert.equal(s.sent[0].attrs.type, 'media');
  assert.equal(s.sent[0].attrs.participant, 'peer@s.whatsapp.net');
  assert.equal(s.sent[0].attrs.error, undefined);
  assert.deepEqual(s.handled, []);
});
test(
  'offline Status drains in the existing sequential queue and messages still arrive',
  { timeout: 5000 },
  async () => {
    const s = await seam(candidate);
    await s.callbacks.get('CB:status')(stanza('offline-1', true));
    await s.callbacks.get('CB:status')(stanza('offline-2', true));
    const completed = once(s.progress, 'message:next-message');
    await s.callbacks.get('CB:message')({
      tag: 'message',
      attrs: { id: 'next-message', from: 'peer@s.whatsapp.net', offline: 'true' },
    });
    await completed;
    assert.deepEqual(
      s.sent.map((x) => x.attrs.id),
      ['offline-1', 'offline-2'],
    );
    assert.deepEqual(s.handled, ['next-message']);
  },
);
test('ACK error is contained; later offline message is not stranded', { timeout: 5000 }, async () => {
  const s = await seam(candidate);
  s.failNext();
  await s.callbacks.get('CB:status')(stanza('fail', true));
  const completed = once(s.progress, 'message:after-error');
  await s.callbacks.get('CB:message')({
    tag: 'message',
    attrs: { id: 'after-error', from: 'peer@s.whatsapp.net', offline: 'true' },
  });
  await completed;
  assert.equal(s.errors.length, 1);
  assert.deepEqual(s.handled, ['after-error']);
});
test('ignored-JID ACK error is contained by the listener and next Status succeeds', async () => {
  const s = await seam(candidate, () => true);
  s.failNext();
  await s.callbacks.get('CB:status')(stanza('ignored-fail'));
  await s.callbacks.get('CB:status')(stanza('ignored-ok'));
  assert.equal(s.errors.length, 1);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].attrs.id, 'ignored-ok');
  assert.equal(s.sent[0].attrs.error, undefined);
});
test('unreviewed bytes and repeat patch are rejected', () => {
  assert.throws(() => transform(original + '\n'), /Unreviewed/);
  assert.throws(() => transform(transform(original)), /Unreviewed/);
});
