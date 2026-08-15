import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatbotDebounceKey,
  ChatbotDebounceStore,
  processChatbotDebounce,
} from '../src/api/integrations/chatbot/chatbotDebounce';

test('isolates the same remoteJid across instances', async () => {
  const store: ChatbotDebounceStore = {};
  const delivered: Array<{ instance: string; content: string }> = [];
  const remoteJid = '5511999999999@s.whatsapp.net';

  await Promise.all([
    processChatbotDebounce(
      store,
      'message for instance A',
      buildChatbotDebounceKey('instance-a', remoteJid),
      0.01,
      async (content) => {
        delivered.push({ instance: 'instance-a', content });
      },
    ),
    processChatbotDebounce(
      store,
      'message for instance B',
      buildChatbotDebounceKey('instance-b', remoteJid),
      0.01,
      async (content) => {
        delivered.push({ instance: 'instance-b', content });
      },
    ),
  ]);

  assert.deepEqual(
    delivered.sort((left, right) => left.instance.localeCompare(right.instance)),
    [
      { instance: 'instance-a', content: 'message for instance A' },
      { instance: 'instance-b', content: 'message for instance B' },
    ],
  );
  assert.deepEqual(store, {});
});

test('uses an injective tuple key instead of an ambiguous delimiter', () => {
  assert.notEqual(buildChatbotDebounceKey('instance:a', 'contact'), buildChatbotDebounceKey('instance', 'a:contact'));
});

test('still coalesces consecutive messages within one instance', async () => {
  const store: ChatbotDebounceStore = {};
  const delivered: string[] = [];
  const debounceKey = buildChatbotDebounceKey('instance-a', '5511999999999@s.whatsapp.net');

  await Promise.all([
    processChatbotDebounce(store, 'first', debounceKey, 0.01, async (content) => delivered.push(content)),
    processChatbotDebounce(store, 'second', debounceKey, 0.01, async (content) => delivered.push(content)),
  ]);

  assert.deepEqual(delivered, ['first\nsecond']);
  assert.deepEqual(store, {});
});

test('propagates one callback failure to every coalesced waiter', async () => {
  const store: ChatbotDebounceStore = {};
  const debounceKey = buildChatbotDebounceKey('instance-a', '5511999999999@s.whatsapp.net');
  const failure = new Error('n8n unavailable');

  const results = await Promise.allSettled([
    processChatbotDebounce(store, 'first', debounceKey, 0.01, async () => {
      throw failure;
    }),
    processChatbotDebounce(store, 'second', debounceKey, 0.01, async () => {
      throw failure;
    }),
  ]);

  assert.deepEqual(
    results.map((result) => (result.status === 'rejected' ? result.reason : null)),
    [failure, failure],
  );
  assert.deepEqual(store, {});
});
