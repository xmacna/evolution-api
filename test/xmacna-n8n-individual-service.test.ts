import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureIndividualChatbotMessage } from '../src/api/integrations/chatbot/n8n/n8nIndividualMessages';

test('actual N8nService posts individual text/audio events, retains live ownerLid and rejects incomplete batches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-individual-service-'));
  try {
    const outfile = join(dir, 'service.cjs');
    await build({ entryPoints: ['src/api/integrations/chatbot/n8n/services/n8n.service.ts'],
      bundle: true, platform: 'node', format: 'cjs', outfile,
      plugins: [{ name: 'external-boundaries', setup(build) {
        build.onResolve({ filter: /(^axios$|\/base-chatbot\.service$)/ }, args => ({ path: args.path, namespace: 'boundary' }));
        build.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: args.path === 'axios'
          ? 'module.exports = { post: async (...args) => globalThis.__n8nPost(...args) };'
          : 'exports.BaseChatbotService = class { constructor() { this.logger = { error() {}, warn() {} }; } async sendMessageWhatsApp() {} };', loader: 'js' }));
      } }],
    });
    const { N8nService } = await import(outfile);
    const requests: any[] = [];
    (globalThis as any).__n8nPost = async (...args: any[]) => { requests.push(args); return { data: { output: 'reply' } }; };
    const service = new N8nService({}, {}, { get: () => ({ URL: 'https://local.invalid' }) },
      { speechToText: async (source: any) => `transcribed ${source.key.id}` });
    service.configService = { get: () => ({ URL: 'https://local.invalid' }) };
    service.prismaRepository = { integrationSession: { update: async () => undefined } };
    const messages = [
      captureIndividualChatbotMessage({ key: { id: 'text', remoteJid: 'lead@lid', fromMe: false }, messageTimestamp: 1792788000, message: { conversation: 'hello' } }, 'hello'),
      captureIndividualChatbotMessage({ key: { id: 'audio', remoteJid: 'lead@lid', fromMe: false }, messageTimestamp: 1792788001, message: { audioMessage: {}, base64: 'private' } }, 'audioMessage|id'),
    ];
    const args = [{ instanceName: 'local', token: 'local-token', client: { user: { lid: '123:7@lid' } } },
      { id: 'session', sessionId: 'session' }, {}, { webhookUrl: 'https://local.invalid/hook' }, 'lead@lid', 'Lead', 'hello\naudioMessage|id',
      { key: { id: 'audio', fromMe: false }, messageTimestamp: 1792788001, debounceMetadata: { messageCount: 2, individualMessages: messages } }];
    await service.sendMessageToBot(...args);
    assert.equal(requests.length, 1);
    const payload = requests[0][1];
    assert.equal(payload.ownerLid, '123');
    assert.equal(payload.chatInput, 'hello\n[audio] transcribed audio');
    assert.deepEqual(payload.individualMessages.map((m: any) => m.keyId), ['text', 'audio']);
    assert.doesNotMatch(JSON.stringify(payload.individualMessages), /audioSource|base64|private/);
    args[7] = { debounceMetadata: { messageCount: 3, individualMessages: messages } };
    await assert.rejects(service.sendMessageToBot(...args), /Incomplete individual n8n events/);
    assert.equal(requests.length, 1);
    delete (globalThis as any).__n8nPost;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
