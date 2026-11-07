import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

import { getInteractiveResponseContent } from '../src/utils/interactiveResponseContent';

const selection = (name = 'quick_reply', paramsJson = '{"id":"Quero conhecer"}') => ({
  // Shape from #1061, synthetic values only. Private params were not available.
  messageContextInfo: {},
  interactiveResponseMessage: { nativeFlowResponseMessage: { name, paramsJson }, body: { text: 'metadata fallback' } },
});

test('native-flow allowlist extracts exactly one semantic id', () => {
  for (const name of ['quick_reply', 'single_select']) {
    assert.equal(getInteractiveResponseContent(selection(name).interactiveResponseMessage), 'Quero conhecer');
  }
});

test('malformed, unknown and non-selection flows do not invent content', () => {
  for (const params of ['', '{', 'null', '[]', '1', '"text"', '{}', '{"id":true}', '{"id":{}}',
    '{"id":"  "}', '{"id":"unknown"}', '{"id":"a\\u0000b"}', JSON.stringify({ id: 'x'.repeat(1025) }),
    JSON.stringify({ id: 'ok', metadata: 'x'.repeat(16384) }), '{"display_text":"metadata"}']) {
    assert.equal(getInteractiveResponseContent(selection('quick_reply', params).interactiveResponseMessage), undefined);
  }
  for (const name of ['unknown', 'galaxy_message', 'cta_url', 'send_location', 'payment_info']) {
    assert.equal(getInteractiveResponseContent(selection(name).interactiveResponseMessage), undefined);
  }
  for (const value of [null, [], '', {}, { nativeFlowResponseMessage: {} }]) {
    assert.equal(getInteractiveResponseContent(value), undefined);
  }
});

test('real normalizer and n8n controller preserve filtering, legacy paths and receipt dedupe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interactive-1061-'));
  try {
    const outfile = join(dir, 'controller.cjs');
    await build({
      stdin: { contents: `export {N8nController} from './src/api/integrations/chatbot/n8n/controllers/n8n.controller';
        export {getConversationMessage} from './src/utils/getConversationMessage';
        export {PrismaInboundInbox,inboundPayloadHash} from './src/api/integrations/channel/whatsapp/inboundInbox';
        export {Prisma} from '@prisma/client';`,
        resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', outfile,
      plugins: [{ name: 'external-boundaries', setup(builder) {
        builder.onResolve({ filter: /^(@api\/server.module|@config\/env.config|@config\/logger.config|@exceptions|@prisma\/client)$/ }, args => ({ path: args.path, namespace: 'boundary' }));
        builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ loader: 'js', contents:
          args.path === '@config/env.config' ? 'exports.configService={get:key=>key==="N8N"?{ENABLED:true}:{ENABLE:false}};'
            : args.path === '@config/logger.config' ? 'exports.Logger=class{log(){}warn(){}error(){}};'
              : args.path === '@exceptions' ? 'exports.BadRequestException=Error;'
                : args.path === '@prisma/client' ? 'exports.Prisma={TransactionIsolationLevel:{Serializable:"Serializable"},PrismaClientKnownRequestError:class extends Error{constructor(message,options){super(message);this.code=options.code;}}};exports.TriggerOperator={};exports.TriggerType={};'
                  : 'module.exports={};' }));
      } }],
    });
    const { N8nController, getConversationMessage, PrismaInboundInbox, inboundPayloadHash, Prisma } = await import(pathToFileURL(outfile).href);
    const sent: any[] = [], paused: any[] = [];
    const settings = { listeningFromMe: false, stopBotFromMe: true, ignoreJids: ['@g.us'], debounceTime: 0 };
    const repository = { n8n: {}, n8nSetting: { findFirst: async () => settings }, integrationSession: { update: async (value: any) => { paused.push(value); } } };
    const instance = { instanceName: 'synthetic', instanceId: 'instance-1' };
    const controller = new N8nController({ process: async (...args: any[]) => { sent.push(args); } }, repository, { waInstances: { synthetic: instance } });
    controller.getSession = async () => ({ id: 'session-1', status: 'opened' });
    controller.findBotTrigger = async () => ({ ...settings });
    const msg = { key: { id: 'synthetic-1', remoteJid: 'lead@s.whatsapp.net', fromMe: false }, message: selection() };

    assert.equal(getConversationMessage(msg), 'Quero conhecer');
    let receipt: any;
    const store = {
      instance: { findUnique: async () => ({ inboundInboxMode: 'enforce' }) },
      inboundReceipt: {
        create: async ({ data }: any) => {
          if (receipt) throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002' });
          receipt = { id: 'receipt-1', ...data };
          return receipt;
        },
        findUnique: async ({ where }: any) => {
          assert.equal(where.sourceCluster_instanceScope_messageId.messageId, msg.key.id);
          return receipt;
        },
        update: async () => receipt,
      },
    };
    const inbox = new PrismaInboundInbox({ ...store, $transaction: async (callback: any) => callback(store) });
    const dispatch = async () => {
      const claim = await inbox.claim({ sourceCluster: 'local', instanceId: instance.instanceId,
        instanceScope: 'synthetic', contactScope: msg.key.remoteJid, messageId: msg.key.id,
        classification: 'real', payloadHash: inboundPayloadHash(msg), leaseOwner: 'test' }, 'enforce');
      if (claim.shouldDispatch) await controller.emit({ instance, remoteJid: msg.key.remoteJid, msg });
      return claim;
    };
    assert.equal((await dispatch()).kind, 'claimed');
    assert.equal(sent.length, 1);
    assert.equal(sent[0][5], 'Quero conhecer');
    assert.equal((await dispatch()).kind, 'duplicate');
    assert.equal(sent.length, 1);

    await controller.emit({ instance, remoteJid: 'group@g.us', msg });
    await controller.emit({ instance, remoteJid: msg.key.remoteJid, msg: { ...msg, key: { ...msg.key, fromMe: true } } });
    await controller.emit({ instance, remoteJid: msg.key.remoteJid, msg: { ...msg, message: selection('quick_reply', '{') } });
    await controller.emit({ instance, remoteJid: msg.key.remoteJid, msg: { ...msg, message: { reactionMessage: { text: '👍' } } } });
    assert.equal(sent.length, 1);
    assert.equal(paused.length, 1);

    const legacy: Array<[any, string]> = [
      [{ listResponseMessage: { title: 'Lista', singleSelectReply: { selectedRowId: 'row' } } }, 'Lista'],
      [{ buttonsResponseMessage: { selectedButtonId: 'button' } }, 'button'],
      [{ templateButtonReplyMessage: { selectedId: 'template' } }, 'template'],
      [{ conversation: 'Texto', ...selection() }, 'Texto'],
    ];
    for (const [message, expected] of legacy) assert.equal(getConversationMessage({ ...msg, message }), expected);
    assert.equal(getConversationMessage({ ...msg, message: selection('unsupported'), contextInfo: { externalAdReply: { body: 'Anúncio' } } }), 'externalAdReplyBody|Anúncio');
    assert.equal(getConversationMessage({ ...msg, contextInfo: { externalAdReply: { body: 'Anúncio' } } }), 'Quero conhecer\nexternalAdReplyBody|Anúncio');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
