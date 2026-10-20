import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatGroupParticipantHeader,
  formatGroupParticipantLabel,
} from '../src/api/integrations/chatbot/chatwoot/chatwootGroupParticipant';
import { ChatwootService } from '../src/api/integrations/chatbot/chatwoot/services/chatwoot.service';

// xmacna/elysium#961: group messages without `participant`, or whose participant is a LID, threw
// `Cannot read properties of undefined (reading 'split' | 'formatInternational')` in the Chatwoot
// sink. In `enforce` the durable inbox retried the receipt 10 times and marked it `dead`.

const GROUP = '120363000000000000@g.us';
const PHONE = '5511987654321@s.whatsapp.net';
const LID = '123456789012345@lid';

test('phone participant keeps the international format', () => {
  assert.equal(formatGroupParticipantLabel({ participant: PHONE }), '+55 11 98765 4321');
  assert.equal(formatGroupParticipantLabel({ participant: '5511987654321:12@s.whatsapp.net' }), '+55 11 98765 4321');
});

test('LID addressing prefers participantAlt and falls back to participant', () => {
  const lidKey = { addressingMode: 'lid', fromMe: false, participant: LID };
  assert.equal(formatGroupParticipantLabel({ ...lidKey, participantAlt: PHONE }), '+55 11 98765 4321');
  assert.equal(formatGroupParticipantLabel(lidKey), '123456789012345');
});

test('missing participant falls back to participantAlt, then to the push name only', () => {
  assert.equal(formatGroupParticipantLabel({ participantAlt: PHONE }), '+55 11 98765 4321');
  assert.equal(formatGroupParticipantLabel({}), undefined);
  assert.equal(formatGroupParticipantHeader({}, 'Maria'), '**Maria:**');
  assert.equal(formatGroupParticipantHeader({}, undefined), '');
});

test('identifier that is not a phone number is shown raw', () => {
  assert.equal(formatGroupParticipantLabel({ participant: '0@s.whatsapp.net' }), '0');
});

const runGroupText = async (key: Record<string, unknown>, pushName?: string) => {
  const sent: string[] = [];
  const instance = { instanceName: 'local-961' };
  const self = Object.create(ChatwootService.prototype);
  Object.assign(self, {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, verbose: () => undefined },
    provider: {},
    waMonitor: { waInstances: { [instance.instanceName]: { instance: { inboundInboxMode: 'enforce' } } } },
    configService: { get: () => ({ MODE: 'enforce' }) },
    prismaRepository: { message: { findFirst: async () => null } },
    clientCw: async () => ({}),
    createConversation: async () => 42,
    createMessage: async (_instance: unknown, _conversation: unknown, content: string) => {
      sent.push(content);
      return { id: 1 };
    },
  });

  const body = {
    key: { id: 'LOCAL961', remoteJid: GROUP, fromMe: false, ...key },
    pushName,
    message: { conversation: 'oi' },
    messageType: 'conversation',
  };
  const result = await self.eventWhatsapp('messages.upsert', instance, body);
  return { result, sent };
};

test('group text without participant reaches Chatwoot instead of throwing', async () => {
  const { result, sent } = await runGroupText({}, 'Maria');
  assert.deepEqual(result, { id: 1 });
  assert.deepEqual(sent, ['**Maria:**\n\noi']);
});

test('group text from a LID participant without participantAlt reaches Chatwoot', async () => {
  const { sent } = await runGroupText({ addressingMode: 'lid', participant: LID }, 'Maria');
  assert.deepEqual(sent, ['**123456789012345 - Maria:**\n\noi']);
});

test('group text from a phone participant keeps the existing header', async () => {
  const { sent } = await runGroupText({ participant: PHONE }, 'Maria');
  assert.deepEqual(sent, ['**+55 11 98765 4321 - Maria:**\n\noi']);
});
