import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatbotDebounceKey,
  ChatbotDebounceMetadata,
  ChatbotDebounceStore,
  normalizeMessageTimestamp,
  processChatbotDebounce,
} from '../src/api/integrations/chatbot/chatbotDebounce';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('isolates the same remoteJid across instances', async () => {
  const store: ChatbotDebounceStore = {};
  const delivered: Array<{ instance: string; content: string }> = [];
  const remoteJid = '5511999999999@s.whatsapp.net';

  await Promise.all(
    [
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
    ].map((acceptance) => acceptance.flushed),
  );

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

  const first = processChatbotDebounce(store, 'first', debounceKey, 0.01, async (content) =>
    void delivered.push(content),
  );
  const second = processChatbotDebounce(store, 'second', debounceKey, 0.01, async (content) =>
    void delivered.push(content),
  );

  assert.equal(first.merged, false);
  assert.equal(second.merged, true);

  await Promise.all([first.flushed, second.flushed]);

  assert.deepEqual(delivered, ['first\nsecond']);
  assert.deepEqual(store, {});
});

test('reports one callback failure on every coalesced acceptance receipt', async () => {
  const store: ChatbotDebounceStore = {};
  const debounceKey = buildChatbotDebounceKey('instance-a', '5511999999999@s.whatsapp.net');
  const failure = new Error('n8n unavailable');
  const reported: unknown[] = [];

  const acceptances = [
    processChatbotDebounce(store, 'first', debounceKey, 0.01, async () => {
      throw failure;
    }),
    processChatbotDebounce(
      store,
      'second',
      debounceKey,
      0.01,
      async () => {
        throw failure;
      },
      { onFlushError: (error) => void reported.push(error) },
    ),
  ];

  const results = await Promise.allSettled(acceptances.map((acceptance) => acceptance.flushed));

  assert.deepEqual(
    results.map((result) => (result.status === 'rejected' ? result.reason : null)),
    [failure, failure],
  );
  // A falha do flush destacado precisa ter um lugar proprio para aparecer: o
  // chamador na fila da instancia ja seguiu em frente.
  assert.deepEqual(reported, [failure]);
  assert.deepEqual(store, {});
});

// xmacna/elysium#518 — Reproducao da chegada SERIALIZADA.
//
// `BaileysMessageProcessor` mantem uma unica cadeia de Promise por instancia
// (`this.queue = this.queue.then(...)`), e o sink duravel `chatbot` faz
// `await chatbotController.emitDurableInbound(...)`. Logo a 2a mensagem do lead
// so comeca a ser processada depois que o `emit` da 1a resolveu. Enquanto o
// debounce so resolvia no flush, isso significava (a) nunca coalescer e
// (b) prender a instancia por `debounceTime + tempo do workflow` por mensagem.
//
// Diferente dos testes acima, aqui NAO ha `Promise.all`: e exatamente o que a
// fila faz em producao.
test('coalesces messages that arrive serialized through the Baileys queue (#518)', async () => {
  const store: ChatbotDebounceStore = {};
  const delivered: string[] = [];
  const debounceKey = buildChatbotDebounceKey('instance-a', '5511999999999@s.whatsapp.net');
  const debounceSeconds = 0.2;

  const enqueue = async (content: string) => {
    await processChatbotDebounce(store, content, debounceKey, debounceSeconds, async (merged) => {
      delivered.push(merged);
    });
  };

  const startedAt = Date.now();
  await enqueue('primeira');
  const acceptanceMs = Date.now() - startedAt;
  await enqueue('segunda');
  await enqueue('terceira');

  // A instancia nao pode ficar bloqueada por uma janela de debounce por mensagem.
  assert.ok(
    acceptanceMs < debounceSeconds * 1000,
    `aceitacao no buffer levou ${acceptanceMs}ms (janela de ${debounceSeconds * 1000}ms): a fila da instancia ficou presa`,
  );

  await sleep(debounceSeconds * 1000 + 200);

  assert.deepEqual(delivered, ['primeira\nsegunda\nterceira']);
  assert.deepEqual(store, {});
});

test('a slow flush never blocks the next message of the same lead (#518)', async () => {
  const store: ChatbotDebounceStore = {};
  const debounceKey = buildChatbotDebounceKey('instance-a', '5511999999999@s.whatsapp.net');
  let flushStarted = 0;

  let firstFlushFinished = false;

  // Workflow lento: 300ms depois do flush. Antes do #518 isso somava ao lock.
  const first = processChatbotDebounce(store, 'primeira', debounceKey, 0.05, async () => {
    flushStarted += 1;
    await sleep(300);
    firstFlushFinished = true;
  });

  // Espera a janela fechar e o flush comecar, mas NAO terminar.
  await sleep(100);
  assert.equal(flushStarted, 1);
  assert.equal(firstFlushFinished, false);

  // Enquanto o workflow da 1a ainda corre, a 2a precisa ser aceita na hora e
  // abrir um buffer novo (a 1a ja foi despachada e saiu do store).
  const startedAt = Date.now();
  const second = processChatbotDebounce(store, 'segunda', debounceKey, 0.05, async () => undefined);
  assert.ok(Date.now() - startedAt < 50);
  assert.equal(second.merged, false);

  await second.flushed;
  assert.equal(firstFlushFinished, false, 'o flush da 2a nao pode esperar o workflow da 1a');
  await first.flushed;
  assert.equal(firstFlushFinished, true);
  assert.deepEqual(store, {});
});

test('accumulates debounce metadata for the n8n payload (#518)', async () => {
  const store: ChatbotDebounceStore = {};
  const debounceKey = buildChatbotDebounceKey('instance-a', '5511999999999@s.whatsapp.net');
  let seen: ChatbotDebounceMetadata | undefined;

  const callback = async (_content: string, metadata: ChatbotDebounceMetadata) => {
    seen = metadata;
  };

  const first = processChatbotDebounce(store, 'primeira', debounceKey, 0.05, callback, {
    messageTimestamp: 1757600000,
  });
  assert.deepEqual(first.metadata, {
    messageCount: 1,
    firstMessageTimestamp: 1757600000,
    lastMessageTimestamp: 1757600000,
  });

  processChatbotDebounce(store, 'segunda', debounceKey, 0.05, callback, { messageTimestamp: '1757600007' });
  const third = processChatbotDebounce(store, 'terceira', debounceKey, 0.05, callback, {
    messageTimestamp: 1757600014,
  });

  assert.deepEqual(third.metadata, {
    messageCount: 3,
    firstMessageTimestamp: 1757600000,
    lastMessageTimestamp: 1757600014,
  });

  await third.flushed;

  assert.deepEqual(seen, {
    messageCount: 3,
    firstMessageTimestamp: 1757600000,
    lastMessageTimestamp: 1757600014,
  });
});

test('normalizes the Baileys messageTimestamp shapes instead of leaking NaN', () => {
  assert.equal(normalizeMessageTimestamp(1757600000), 1757600000);
  assert.equal(normalizeMessageTimestamp('1757600000'), 1757600000);
  assert.equal(normalizeMessageTimestamp({ toNumber: () => 1757600000 }), 1757600000);
  assert.equal(normalizeMessageTimestamp(undefined), undefined);
  assert.equal(normalizeMessageTimestamp(''), undefined);
  assert.equal(normalizeMessageTimestamp('nao-e-numero'), undefined);
  assert.equal(normalizeMessageTimestamp(Number.NaN), undefined);
});
