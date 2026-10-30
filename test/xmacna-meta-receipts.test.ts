import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BusinessStartupService } from '../src/api/integrations/channel/meta/whatsapp.business.service';
import { chatbotController } from '../src/api/server.module';
import { Events } from '../src/api/types/wa.types';

const INSTANCE = 'local-meta-receipts';
const RECIPIENT = '5511987654321';
const JID = `${RECIPIENT}@s.whatsapp.net`;
const metadata = { phone_number_id: 'local-phone-id' };

function harness() {
  const updates: any[] = [];
  const messages: any[] = [];
  const contacts: any[] = [];
  const events: any[] = [];
  const errors: unknown[] = [];
  const self: any = Object.create(BusinessStartupService.prototype);
  Object.assign(self, {
    instance: { id: INSTANCE, name: INSTANCE },
    phoneNumber: '5511000000000@s.whatsapp.net',
    localSettings: {},
    logger: { log() {}, warn() {}, error: (error: unknown) => errors.push(error) },
    configService: { get: () => ({ ENABLED: false }) },
    sendDataWebhook: (event: string, body: unknown) => events.push({ event, body }),
    prismaRepository: {
      message: {
        findFirst: async ({ where }: any) => {
          assert.equal(where.instanceId, INSTANCE);
          const id = where.key.equals;
          if (id === 'unknown') return null;
          return { id: `db-${id}`, key: { id, remoteJid: JID, fromMe: true } };
        },
        create: async ({ data }: any) => {
          messages.push(data);
          return { id: 'db-inbound', ...data };
        },
      },
      messageUpdate: {
        create: async ({ data }: any) => {
          updates.push(data);
          return data;
        },
      },
      contact: {
        findFirst: async () => null,
        create: async ({ data }: any) => {
          contacts.push(data);
          return data;
        },
      },
    },
  });
  return { self, updates, messages, contacts, events, errors };
}

const receipt = (id: string, status: string) => ({ id, status, recipient_id: RECIPIENT, timestamp: '1700000000' });

for (const [name, contacts] of [
  ['absent contacts', undefined],
  ['empty contacts', []],
  ['contacts without profile', [{ wa_id: RECIPIENT }]],
] as const) {
  test(`statuses-only persists the exact message relation with ${name}`, async () => {
    const h = harness();
    await h.self.messageHandle({ metadata, contacts, statuses: [receipt('one', 'delivered')] }, {}, {});
    assert.deepEqual(h.errors, []);
    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0].messageId, 'db-one');
    assert.equal(h.updates[0].keyId, 'one');
    assert.equal(h.updates[0].instanceId, INSTANCE);
    assert.equal(h.updates[0].status, 'DELIVERED');
    assert.equal(h.updates[0].remoteJid, JID);
    assert.equal(h.updates[0].fromMe, true);
    assert.deepEqual(h.messages, []);
    assert.deepEqual(h.contacts, []);
  });
}

test('an unknown message does not discard the remaining status batch', async () => {
  const h = harness();
  await h.self.messageHandle({ metadata, statuses: [receipt('unknown', 'sent'), receipt('two', 'delivered')] }, {}, {});
  assert.deepEqual(
    h.updates.map((x) => [x.messageId, x.status]),
    [['db-two', 'DELIVERED']],
  );
});

test('failed and delivered receipts are both persisted without treating failed as delivered', async () => {
  const h = harness();
  await h.self.messageHandle({ metadata, statuses: [receipt('one', 'failed'), receipt('two', 'delivered')] }, {}, {});
  assert.deepEqual(
    h.updates.map((x) => [x.keyId, x.status]),
    [
      ['one', 'FAILED'],
      ['two', 'DELIVERED'],
    ],
  );
});

test('each receipt keeps the original message recipient even when the webhook recipient changes', async () => {
  const h = harness();
  const secondJid = '5521987654321@s.whatsapp.net';
  h.self.prismaRepository.message.findFirst = async ({ where }: any) => ({
    id: `db-${where.key.equals}`,
    key: { id: where.key.equals, remoteJid: where.key.equals === 'one' ? JID : secondJid, fromMe: true },
  });
  await h.self.messageHandle({ metadata, statuses: [receipt('one', 'sent'), receipt('two', 'delivered')] }, {}, {});
  assert.deepEqual(
    h.updates.map((x) => x.remoteJid),
    [JID, secondJid],
  );
});

test('relay failure cannot prevent local persistence or a later receipt in the batch', async () => {
  const h = harness();
  h.self.sendDataWebhook = async () => {
    throw new Error('synthetic relay failure');
  };
  await h.self.messageHandle({ metadata, statuses: [receipt('one', 'failed'), receipt('two', 'delivered')] }, {}, {});
  assert.deepEqual(
    h.updates.map((x) => x.status),
    ['FAILED', 'DELIVERED'],
  );
  assert.equal(h.errors.length, 2);
});

test('a deleted message does not discard the remaining status batch', async () => {
  const h = harness();
  await h.self.messageHandle(
    { metadata, statuses: [{ id: 'one', message: null, recipient_id: RECIPIENT }, receipt('two', 'delivered')] },
    {},
    {},
  );
  assert.deepEqual(
    h.updates.map((x) => x.status),
    ['DELETED', 'DELIVERED'],
  );
});

test('a malformed status does not discard a subsequent valid receipt', async () => {
  const h = harness();
  await h.self.messageHandle(
    { metadata, statuses: [{ id: 'one', recipient_id: RECIPIENT }, receipt('two', 'delivered')] },
    {},
    {},
  );
  assert.deepEqual(
    h.updates.map((x) => x.status),
    ['DELIVERED'],
  );
});

test('ordinary incoming text still reaches persistence, chatbot, and contact ingestion', async () => {
  const h = harness();
  const originalEmit = chatbotController.emit;
  const chatbotMessages: any[] = [];
  chatbotController.emit = async (input: any) => {
    chatbotMessages.push(input);
  };
  try {
    h.self.phoneNumber = JID;
    await h.self.messageHandle(
      {
        metadata,
        contacts: [{ wa_id: RECIPIENT, profile: { name: 'Synthetic contact' } }],
        messages: [
          { id: 'incoming', from: RECIPIENT, type: 'text', text: { body: 'local fixture' }, timestamp: '1700000000' },
        ],
      },
      {},
      {},
    );
    assert.deepEqual(h.errors, []);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].key.remoteJid, JID);
    assert.equal(h.messages[0].key.fromMe, false);
    assert.equal(h.messages[0].pushName, 'Synthetic contact');
    assert.equal(h.messages[0].message.conversation, 'local fixture');
    assert.equal(chatbotMessages.length, 1);
    assert.equal(h.contacts[0].remoteJid, JID);
    assert.ok(h.events.some((x) => x.event === Events.MESSAGES_UPSERT));
  } finally {
    chatbotController.emit = originalEmit;
  }
});

test('connect establishes recipient identity before dispatch and waits for processing', async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observedJid: string;
  let completed = false;
  let settled = false;
  h.self.loadChatwoot = async () => undefined;
  h.self.eventHandler = async () => {
    observedJid = h.self.phoneNumber;
    await gate;
    completed = true;
  };
  const running = h.self.connectToWhatsapp({
    entry: [{ changes: [{ value: { metadata, statuses: [receipt('one', 'sent')] } }] }],
  });
  void running.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observedJid, JID);
  assert.equal(settled, false);
  release();
  await running;
  assert.equal(completed, true);
});

test('eventHandler waits until a status has actually been persisted', async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  let settled = false;
  h.self.findSettings = async () => ({});
  h.self.messageHandle = async () => {
    await gate;
    completed = true;
  };
  const running = h.self.eventHandler({ metadata, statuses: [receipt('one', 'sent')] });
  void running.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await running;
  assert.equal(completed, true);
});

for (const firstId of ['one', 'unknown']) {
  test(`connect accepts the first ${firstId} receipt without recipient_id and processes the rest`, async () => {
    const h = harness();
    h.self.loadChatwoot = async () => undefined;
    h.self.findSettings = async () => ({});
    await h.self.connectToWhatsapp({
      entry: [
        {
          changes: [
            {
              value: {
                metadata,
                statuses: [{ id: firstId, status: 'sent' }, receipt('two', 'delivered')],
              },
            },
          ],
        },
      ],
    });
    assert.deepEqual(h.errors, []);
    assert.deepEqual(
      h.updates.map((x) => [x.keyId, x.status]),
      firstId === 'one'
        ? [
            ['one', 'SENT'],
            ['two', 'DELIVERED'],
          ]
        : [['two', 'DELIVERED']],
    );
  });
}
