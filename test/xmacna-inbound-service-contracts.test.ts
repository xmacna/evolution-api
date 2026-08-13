import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { mergeRequestIdentity } from '../src/api/abstract/requestIdentity';
import { applyDeliveryErrorPolicy } from '../src/api/integrations/chatbot/deliveryErrorPolicy';

test('durable delivery policy propagates errors while baseline policy preserves swallow semantics', () => {
  const error = new Error('n8n unavailable');
  assert.throws(() => applyDeliveryErrorPolicy(error, true), /n8n unavailable/);
  assert.doesNotThrow(() => applyDeliveryErrorPolicy(error, false));

  const n8nSource = readFileSync('src/api/integrations/chatbot/n8n/services/n8n.service.ts', 'utf8');
  assert.match(n8nSource, /shouldPropagateDeliveryErrors\(\): boolean \{\s*return true;/);
  assert.match(n8nSource, /catch \(error\) \{[\s\S]*?throw error;\s*\}/);
});

test('inbound failure propagation at the controller is opt-in per integrator (n8n only)', () => {
  const baseSource = readFileSync('src/api/integrations/chatbot/base-chatbot.controller.ts', 'utf8');
  assert.match(baseSource, /protected shouldPropagateInboundFailure\(\): boolean \{\s*return false;/);
  assert.match(baseSource, /this\.shouldPropagateInboundFailure\(\) &&[\s\S]{0,200}throw error;/);

  const n8nSource = readFileSync('src/api/integrations/chatbot/n8n/controllers/n8n.controller.ts', 'utf8');
  assert.match(n8nSource, /protected override shouldPropagateInboundFailure\(\): boolean \{\s*return true;/);

  for (const controller of [
    'src/api/integrations/chatbot/dify/controllers/dify.controller.ts',
    'src/api/integrations/chatbot/openai/controllers/openai.controller.ts',
    'src/api/integrations/chatbot/typebot/controllers/typebot.controller.ts',
    'src/api/integrations/chatbot/evolutionBot/controllers/evolutionBot.controller.ts',
    'src/api/integrations/chatbot/evoai/controllers/evoai.controller.ts',
    'src/api/integrations/chatbot/flowise/controllers/flowise.controller.ts',
  ]) {
    assert.doesNotMatch(
      readFileSync(controller, 'utf8'),
      /shouldPropagateInboundFailure/,
      `${controller} must inherit the swallow default; a transient failure there would replay the aggregate chatbot sink`,
    );
  }
});

test('route instanceName wins over query and prevents cross-tenant retargeting', async () => {
  const received = mergeRequestIdentity(
    { instanceName: 'tenant-authenticated' },
    { instanceName: 'tenant-attacker', number: '5511' },
  );
  assert.equal(received.instanceName, 'tenant-authenticated');
  assert.equal(received.number, '5511');
});

test('Chatwoot uses WAID preflight and surfaces media delivery failures in enforce', () => {
  const source = readFileSync('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', 'utf8');
  const createStart = source.indexOf('public async createMessage(');
  const preflight = source.indexOf('chatwootImport.getExistingMessageBySourceId(sourceId, conversationId)', createStart);
  const createCall = source.indexOf('client.messages.create(', createStart);
  assert.ok(createStart >= 0 && preflight > createStart && createCall > preflight);
  assert.match(source, /if \(this\.shouldSurfaceInboundFailure\(instance\)\) throw error;/);

  const importSource = readFileSync(
    'src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper.ts',
    'utf8',
  );
  assert.match(importSource, /SELECT id, inbox_id, conversation_id, source_id/);
});

test('health stats expose fresh unique traffic separately from duplicate replays', () => {
  const source = readFileSync('src/api/controllers/instance.controller.ts', 'utf8');
  assert.match(source, /_max: \{ createdAt: true, lastSeenAt: true \}/);
  assert.match(source, /lastReceiptCreatedAt: totals\._max\.createdAt/);
  assert.match(source, /lastInboundSeenAt: totals\._max\.lastSeenAt/);
});
