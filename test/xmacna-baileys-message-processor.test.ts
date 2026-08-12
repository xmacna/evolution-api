import assert from 'node:assert/strict';
import test from 'node:test';

import { BaileysMessageProcessor } from '../src/api/integrations/channel/whatsapp/baileysMessage.processor';

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a poison message exhausts its retries without blocking the next item in the batch', async () => {
  const processor = new BaileysMessageProcessor(0, 1);
  const calls: string[] = [];
  processor.mount({
    onMessageReceive: async ({ messages }) => {
      const id = messages[0].key.id!;
      calls.push(id);
      if (id === 'poison') throw new Error('sink failed');
    },
  });

  processor.processMessage(
    {
      type: 'notify',
      messages: [
        { key: { id: 'poison' }, message: { conversation: 'A' } },
        { key: { id: 'healthy' }, message: { conversation: 'B' } },
      ],
    } as any,
    {},
  );

  await waitFor(() => calls.includes('healthy'));
  assert.deepEqual(calls, ['poison', 'poison', 'healthy']);
  processor.onDestroy();
});

test('batches remain serialized', async () => {
  const processor = new BaileysMessageProcessor(0, 0);
  const order: string[] = [];
  processor.mount({
    onMessageReceive: async ({ messages }) => {
      const id = messages[0].key.id!;
      order.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, id === 'first' ? 10 : 0));
      order.push(`end:${id}`);
    },
  });
  processor.processMessage(
    {
      type: 'notify',
      messages: [
        { key: { id: 'first' }, message: { conversation: 'A' } },
        { key: { id: 'second' }, message: { conversation: 'B' } },
      ],
    } as any,
    {},
  );
  await waitFor(() => order.includes('end:second'));
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
  processor.onDestroy();
});
