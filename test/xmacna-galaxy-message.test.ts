import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

import { getGalaxyMessageContent, getInteractiveResponseContent } from '../src/utils/galaxyMessageContent';
import { getConversationMessage } from '../src/utils/getConversationMessage';

const galaxyMessage = (paramsJson = JSON.stringify({
  screen_0_Email_1: 'lucca.synthetic@example.invalid',
  screen_0_Name_0: 'Pessoa Sintética',
  flow_token: 'synthetic-flow-token-must-not-leak',
  flow_id: 'synthetic-flow-id-must-not-leak',
  wa_flow_response_params: { flow_name: 'private metadata must not leak' },
})) => ({
  key: { id: 'synthetic-message', remoteJid: 'lead@s.whatsapp.net', fromMe: false },
  message: {
    interactiveResponseMessage: {
      body: { text: 'Participar agora' },
      nativeFlowResponseMessage: { name: 'galaxy_message', version: 3, paramsJson },
      contextInfo: { externalAdReply: { body: 'nested-ad-metadata-must-not-leak' } },
    },
  },
  contextInfo: {
    externalAdReply: { body: 'root-ad-metadata-must-not-leak' },
    ctwaPayload: 'ad-metadata-must-not-leak',
    conversionData: 'conversion-metadata-must-not-leak',
  },
});

test('galaxy_message emits only body text and ordered screen fields', () => {
  const content = getConversationMessage(galaxyMessage());
  assert.equal(content, 'Participar agora\nName: Pessoa Sintética\nEmail: lucca.synthetic@example.invalid');
  assert.doesNotMatch(content!, /flow_token|flow_id|wa_flow|private metadata|must-not-leak|ctwa|conversionData/);
});

test('invalid paramsJson and payloads without screen fields use a neutral message', () => {
  for (const paramsJson of ['{', 'null', '[]', '"text"', '{}', '{"flow_id":"synthetic"}', '{"screen_0_Name_0":false}']) {
    const response = galaxyMessage(paramsJson).message.interactiveResponseMessage;
    assert.equal(getGalaxyMessageContent(response), '[formulário enviado]');
    assert.equal(getConversationMessage(galaxyMessage(paramsJson)), '[formulário enviado]');
  }
});

test('quick_reply and single_select retain their safe textual id behavior', () => {
  for (const name of ['quick_reply', 'single_select']) {
    const response = {
      nativeFlowResponseMessage: {
        name,
        paramsJson: JSON.stringify({ id: '  answer-id  ', display_text: 'metadata must not leak' }),
      },
      body: { text: 'body text is not a selection value' },
    };
    assert.equal(getInteractiveResponseContent(response), 'answer-id');
    assert.equal(getConversationMessage({ message: { interactiveResponseMessage: response } }), 'answer-id');
  }
  for (const paramsJson of ['{', '{}', '{"id":true}', '{"id":"unknown"}', '{"id":"a\\u0000b"}']) {
    assert.equal(
      getInteractiveResponseContent({ nativeFlowResponseMessage: { name: 'quick_reply', paramsJson } }),
      undefined,
    );
  }
});

test('legacy text, button, list, media and ad fallback retain their current values', () => {
  assert.equal(getConversationMessage({ message: { conversation: 'texto' } }), 'texto');
  assert.equal(getConversationMessage({ message: { buttonsResponseMessage: { selectedButtonId: 'sim' } } }), 'sim');
  assert.equal(getConversationMessage({ message: { listResponseMessage: { title: 'opção' } } }), 'opção');
  assert.equal(getConversationMessage({ key: { id: 'audio-id' }, message: { audioMessage: {} } }), 'audioMessage|audio-id');
  assert.equal(
    getConversationMessage({ message: {}, contextInfo: { externalAdReply: { body: 'anúncio' } } }),
    'externalAdReplyBody|anúncio',
  );
});

test('real N8n controller sends form content for unopened/open sessions and mixed debounce batches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'galaxy-message-'));
  try {
    const outfile = join(dir, 'controller.cjs');
    await build({
      stdin: {
        contents: `export {N8nController} from './src/api/integrations/chatbot/n8n/controllers/n8n.controller';\nexport {N8nService} from './src/api/integrations/chatbot/n8n/services/n8n.service';\nexport {getConversationMessage} from './src/utils/getConversationMessage';`,
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      plugins: [
        {
          name: 'external-boundaries',
          setup(builder) {
            builder.onResolve(
              { filter: /^(@api\/server\.module|@config\/env\.config|@config\/logger\.config|@exceptions|@prisma\/client|axios)$/ },
              (args) => ({ path: args.path, namespace: 'boundary' }),
            );
            builder.onLoad({ filter: /.*/, namespace: 'boundary' }, (args) => ({
              loader: 'js',
              contents:
                args.path === 'axios'
                  ? 'module.exports={post:(...args)=>globalThis.__n8nPost(...args)};'
                  : args.path === '@config/env.config'
                  ? 'exports.configService={get:key=>key==="N8N"?{ENABLED:true}:{ENABLE:false}};'
                  : args.path === '@config/logger.config'
                    ? 'exports.Logger=class{log(){}warn(){}error(){}};'
                    : args.path === '@exceptions'
                      ? 'exports.BadRequestException=Error;'
                      : args.path === '@prisma/client'
                        ? 'exports.TriggerOperator={};exports.TriggerType={};'
                        : 'module.exports={};',
            }));
          },
        },
      ],
    });

    const { N8nController, N8nService, getConversationMessage: normalize } = await import(pathToFileURL(outfile).href);
    const calls: any[] = [];
    (globalThis as any).__n8nPost = async (...args: any[]) => {
      calls.push(args);
      return { data: { output: '' } };
    };
    const service = new N8nService(
      {},
      {
        integrationSession: {
          create: async () => ({ id: 'created-session', sessionId: 'lead@s.whatsapp.net', status: 'opened' }),
          update: async () => undefined,
        },
      },
      { get: () => ({ URL: 'https://local.invalid' }) },
      { speechToText: async () => null },
    );
    const settings = {
      listeningFromMe: false,
      stopBotFromMe: true,
      ignoreJids: [],
      debounceTime: 0.03,
    };
    const instance = { instanceName: 'synthetic', instanceId: 'synthetic-instance' };
    const controller = new N8nController(
      service,
      {
        n8n: {},
        n8nSetting: { findFirst: async () => settings },
        integrationSession: { update: async () => undefined },
      },
      { waInstances: { synthetic: instance } },
    );
    controller.findBotTrigger = async () => ({ ...settings, id: 'synthetic-bot', webhookUrl: 'https://local.invalid/hook' });
    const openedSession = { id: 'opened-session', sessionId: 'opened-session', status: 'opened' };

    const flush = async () => {
      const pending = Object.values(controller.userMessageDebounce) as Array<{ flushed: Promise<void> }>;
      await Promise.all(pending.map(({ flushed }) => flushed));
    };

    controller.getSession = async () => null;
    (controller as any).n8nService = service;
    const noSessionMessage = galaxyMessage();
    await controller.emit({ instance, remoteJid: noSessionMessage.key.remoteJid, msg: noSessionMessage });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].chatInput, normalize(noSessionMessage));
    assert.equal(calls[0][1].sessionId, noSessionMessage.key.remoteJid);
    assert.equal(typeof calls[0][1].chatInput, 'string');

    calls.length = 0;
    controller.getSession = async () => openedSession;
    const openSessionMessage = galaxyMessage();
    await controller.emit({ instance, remoteJid: openSessionMessage.key.remoteJid, msg: openSessionMessage });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].sessionId, openedSession.sessionId);
    assert.match(calls[0][1].chatInput, /^Participar agora\nName: Pessoa Sintética/);
    assert.equal(typeof calls[0][1].chatInput, 'string');
    assert.doesNotMatch(calls[0][1].chatInput, /flow_token|flow_id|must-not-leak/);

    calls.length = 0;
    const formMessage = galaxyMessage();
    const textMessage = {
      key: { id: 'synthetic-text', remoteJid: formMessage.key.remoteJid, fromMe: false },
      message: { conversation: 'pergunta adicional' },
    };
    await controller.emit({ instance, remoteJid: formMessage.key.remoteJid, msg: formMessage });
    await controller.emit({ instance, remoteJid: textMessage.key.remoteJid, msg: textMessage });
    await flush();
    assert.equal(calls.length, 1);
    assert.match(calls[0][1].chatInput, /^Participar agora\nName: Pessoa Sintética/);
    assert.match(calls[0][1].chatInput, /\npergunta adicional$/);
    assert.doesNotMatch(calls[0][1].chatInput, /undefined|flow_token|flow_id|must-not-leak/);

    calls.length = 0;
    const malformedMessage = galaxyMessage('{');
    await controller.emit({ instance, remoteJid: malformedMessage.key.remoteJid, msg: malformedMessage });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].chatInput, '[formulário enviado]');

    calls.length = 0;
    await service.process(instance, 'lead@s.whatsapp.net', {}, openedSession, settings, undefined as any);
    assert.equal(calls.length, 0, 'missing content must stop before toLowerCase or the HTTP body');
    delete (globalThis as any).__n8nPost;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
