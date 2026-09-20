import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attemptDurableInboundSink,
  DurableInboundSinkState,
} from '../src/api/integrations/channel/whatsapp/inboundSinkDispatch';

test('Chatwoot failure is persisted and does not prevent the following n8n sink', async () => {
  const marks: Array<{ sink: string; state: DurableInboundSinkState }> = [];
  const delivered: string[] = [];
  const mark = async (sink: any, state: DurableInboundSinkState) => {
    marks.push({ sink, state });
  };

  const chatwootFailure = await attemptDurableInboundSink({
    sink: 'chatwoot',
    operation: async () => {
      throw new Error('chatwoot unavailable');
    },
    mark,
  });
  const chatbotFailure = await attemptDurableInboundSink({
    sink: 'chatbot',
    operation: async () => {
      delivered.push('n8n');
      return 'sent';
    },
    mark,
  });

  assert.equal(chatwootFailure?.sink, 'chatwoot');
  assert.equal(chatbotFailure, undefined);
  assert.deepEqual(delivered, ['n8n']);
  assert.deepEqual(marks, [
    { sink: 'chatwoot', state: 'failed' },
    { sink: 'chatbot', state: 'sent' },
  ]);
});

test('fencing failure rejects instead of pretending the sink was recorded', async () => {
  await assert.rejects(
    () =>
      attemptDurableInboundSink({
        sink: 'webhook',
        operation: async () => 'sent',
        mark: async () => {
          throw new Error('stale lease');
        },
      }),
    /stale lease/,
  );
});
