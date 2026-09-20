const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('pins the audited Baileys and CommonJS bridge versions', () => {
  const baileysPackage = readJson('node_modules/baileys/package.json');
  const bridgePackage = readJson('node_modules/whatsapp-rust-bridge/package.json');

  assert.equal(baileysPackage.version, '7.0.0-rc14');
  assert.equal(bridgePackage.version, '0.5.5');

  const baileys = require('baileys');
  const bridge = require('whatsapp-rust-bridge');
  assert.equal(typeof baileys.makeWASocket, 'function');
  assert.equal(typeof baileys.BufferJSON, 'object');
  assert.ok(baileys.WAProto?.Message);
  assert.ok(Object.keys(bridge).length > 0);
});

test('round-trips typed auth material with BufferJSON', () => {
  const { BufferJSON } = require('baileys');
  const encoded = JSON.stringify({ key: Uint8Array.from([0, 1, 127, 255]) }, BufferJSON.replacer);
  const decoded = JSON.parse(encoded, BufferJSON.reviver);

  assert.deepEqual(Array.from(decoded.key), [0, 1, 127, 255]);
});

test('contains the upstream CTWA placeholder recovery path', () => {
  const source = read('node_modules/baileys/lib/Socket/messages-recv.js');

  assert.match(source, /NO_MESSAGE_FOUND_ERROR_TEXT/);
  assert.match(source, /requestPlaceholderResend\(cleanKey, msgData\)/);
  assert.match(source, /fall through to upsertMessage so the stub is emitted/);
  assert.match(source, /messageStubParameters: \[NO_MESSAGE_FOUND_ERROR_TEXT, requestId\]/);
});

test('contains the GHSA self-only protocol guard without blocking legitimate cross-user events', () => {
  const source = read('node_modules/baileys/lib/Utils/process-message.js');
  const guardStart = source.indexOf('const SELF_ONLY_TYPES = new Set([');
  const switchStart = source.indexOf('switch (protocolMsg.type)', guardStart);
  assert.ok(guardStart >= 0 && switchStart > guardStart, 'protocol guard not found');

  const guard = source.slice(guardStart, switchStart);
  for (const type of [
    'HISTORY_SYNC_NOTIFICATION',
    'APP_STATE_SYNC_KEY_SHARE',
    'LID_MIGRATION_MAPPING_SYNC',
    'PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE',
  ]) {
    assert.match(guard, new RegExp(`ProtocolMessage\\.Type\\.${type}`));
  }
  for (const type of ['REVOKE', 'MESSAGE_EDIT', 'EPHEMERAL_SETTING', 'GROUP_MEMBER_LABEL_CHANGE']) {
    assert.doesNotMatch(guard, new RegExp(`ProtocolMessage\\.Type\\.${type}[,\\n]`));
    assert.match(source.slice(switchStart), new RegExp(`case proto\\.Message\\.ProtocolMessage\\.Type\\.${type}:`));
  }
  assert.match(guard, /SELF_ONLY_TYPES\.has\(protocolMsg\.type\)[\s\S]*!message\.key\.fromMe/);
});

test('contains the upstream privacy-token send, persistence, and recovery paths', () => {
  const send = read('node_modules/baileys/lib/Socket/messages-send.js');
  const receive = read('node_modules/baileys/lib/Socket/messages-recv.js');

  assert.match(send, /authState\.keys\.get\('tctoken'/);
  assert.match(send, /issuePrivacyTokens/);
  assert.match(send, /authState\.keys\.set\(\{\s*tctoken:/);
  assert.match(receive, /case 'privacy_token':/);
  assert.match(receive, /pruned expired tctokens/);
});

test('Evolution skips rc14 CIPHERTEXT placeholders before any sink effect', () => {
  const source = read('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');
  const handlerStart = source.indexOf("'messages.upsert': async (");
  const handlerEnd = source.indexOf("'messages.update': async", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'messages.upsert handler not found');

  const handler = source.slice(handlerStart, handlerEnd);
  const stubGuard = handler.indexOf("'Message absent from node'");
  const firstSink = Math.min(
    ...['chatwootService.eventWhatsapp', 'sendDataWebhook', 'prismaRepository.message.create']
      .map((needle) => handler.indexOf(needle))
      .filter((index) => index >= 0),
  );

  assert.ok(stubGuard >= 0, 'placeholder guard not found');
  assert.ok(firstSink > stubGuard, 'a sink effect can run before the placeholder guard');
  assert.match(handler.slice(stubGuard, firstSink), /continue;/);
});

test('all auth-state providers persist arbitrary rc14 key categories', () => {
  for (const file of [
    'src/utils/use-multi-file-auth-state-prisma.ts',
    'src/utils/use-multi-file-auth-state-redis-db.ts',
  ]) {
    const source = read(file);
    assert.match(source, /for \(const category in data\)/);
    assert.match(source, /`\$\{category\}-\$\{id\}`/);
  }
});

test('security overrides resolve to the audited runtime versions', () => {
  assert.equal(require('axios/package.json').version, '1.19.0');
  assert.equal(require('link-preview-js/package.json').version, '5.0.0');

  const chatwootRoot = require.resolve('@figuro/chatwoot-sdk');
  const chatwootAxiosPackage = require.resolve('axios/package.json', { paths: [chatwootRoot] });
  assert.equal(require(chatwootAxiosPackage).version, '1.19.0');

  const baileysRoot = require.resolve('baileys');
  const baileysLinkPreviewPackage = require.resolve('link-preview-js/package.json', { paths: [baileysRoot] });
  assert.equal(require(baileysLinkPreviewPackage).version, '5.0.0');

  assert.equal(installedPackage('multer').version, '2.3.0');
  assert.equal(installedPackage('sharp').version, '0.35.4');

  const express = installedPackage('express');
  const bodyParser = installedPackage('body-parser', express.dir);
  assert.equal(installedPackage('qs', express.dir).version, '6.16.0');
  assert.equal(installedPackage('qs', bodyParser.dir).version, '6.16.0');

  // xmacna/elysium#518 (2026-09-14): minio (and its unpatchable stream-json) is gone; the S3
  // wrapper speaks @aws-sdk/client-s3. Pin the swap so a merge never brings minio back.
  assert.throws(() => installedPackage('minio'), /not installed/);
  assert.ok(installedPackage('@aws-sdk/client-s3').version);
  assert.ok(installedPackage('@aws-sdk/s3-request-presigner').version);

  const prismaConfig = installedPackage('@prisma/config', installedPackage('prisma').dir);
  assert.equal(installedPackage('deepmerge-ts', prismaConfig.dir).version, '8.0.0');
});

// Several audited packages do not export ./package.json, so resolve the installed copy the way
// Node does for a parent package: walk node_modules upwards from the parent's directory.
function installedPackage(name, fromDir = root) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const packageDir = path.join(dir, 'node_modules', name);
    const manifest = path.join(packageDir, 'package.json');
    if (fs.existsSync(manifest)) return { dir: packageDir, version: JSON.parse(fs.readFileSync(manifest, 'utf8')).version };
    if (path.dirname(dir) === dir) throw new Error(`${name} is not installed above ${fromDir}`);
  }
}

async function withExpressServer(t, configure) {
  const express = require('express');
  const app = express();
  configure(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('Express 4 urlencoded parsing keeps nested bodies with the qs override', async (t) => {
  const express = require('express');
  const baseUrl = await withExpressServer(t, (app) => {
    app.use(express.urlencoded({ extended: true, limit: '136mb' }));
    app.post('/form', (request, response) => response.json(request.body));
  });

  const response = await fetch(`${baseUrl}/form`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'number=5511999999999&options[delay]=1200&list[0]=a&list[1]=b',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    number: '5511999999999',
    options: { delay: '1200' },
    list: ['a', 'b'],
  });
});

test('multer memoryStorage upload remains compatible after the security update', async (t) => {
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage() });
  const baseUrl = await withExpressServer(t, (app) => {
    app.post('/media', upload.single('file'), (request, response) => {
      response.json({
        number: request.body.number,
        name: request.file.originalname,
        mimetype: request.file.mimetype,
        content: request.file.buffer.toString('utf8'),
      });
    });
  });

  const form = new FormData();
  form.append('number', '5511999999999');
  form.append('file', new Blob(['inbox-probe'], { type: 'text/plain' }), 'probe.txt');
  const response = await fetch(`${baseUrl}/media`, { method: 'POST', body: form });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    number: '5511999999999',
    name: 'probe.txt',
    mimetype: 'text/plain',
    content: 'inbox-probe',
  });
});

test('S3 wrapper presigns through @aws-sdk/client-s3 (minio and its stream-json are gone)', async () => {
  // xmacna/elysium#518 (2026-09-14): the storage wrapper moved from minio to the AWS SDK so the
  // runtime audit can be clean. Pin the presign contract the media callers rely on: path,
  // expiry and a SigV4 signature, with no minio on disk.
  assert.ok(!fs.existsSync(path.join(root, 'node_modules/minio')), 'minio must not be installed');
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:9',
    forcePathStyle: true,
    credentials: { accessKeyId: 'probe-access', secretAccessKey: 'probe-secret' },
  });
  const url = new URL(
    await getSignedUrl(client, new GetObjectCommand({ Bucket: 'evolution', Key: 'media/probe file.jpg' }), { expiresIn: 60 }),
  );
  assert.equal(url.pathname, '/evolution/media/probe%20file.jpg');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
});

test('Prisma config deepmerge keeps plain-object merge semantics on deepmerge-ts 8', async () => {
  const prismaConfigRoot = require.resolve('@prisma/config', { paths: [require.resolve('prisma/package.json')] });
  const { deepmerge } = await import(require.resolve('deepmerge-ts', { paths: [prismaConfigRoot] }));
  assert.deepEqual(deepmerge({ migrations: { path: 'a' }, earlyAccess: false }, { migrations: { seed: 'b' } }), {
    migrations: { path: 'a', seed: 'b' },
    earlyAccess: false,
  });
});

test('Chatwoot SDK request remains compatible with the Axios override', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/api/ping?probe=inbox');
    assert.equal(request.headers.api_access_token, 'test-token');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  const { request } = require('@figuro/chatwoot-sdk/dist/core/request');
  const result = await request(
    {
      basePath: `http://127.0.0.1:${address.port}`,
      with_credentials: false,
      credentials: 'omit',
      token: 'test-token',
    },
    { method: 'GET', url: '/api/ping', query: { probe: 'inbox' } },
  );

  assert.deepEqual(result, { ok: true });
});

test('Baileys link preview, node-cron and sharp major updates keep required APIs', async () => {
  const { getLinkPreview } = await import('link-preview-js');
  assert.equal(typeof getLinkPreview, 'function');

  const cron = require('node-cron');
  assert.equal(cron.validate('0,30 * * * *'), true);
  const task = cron.schedule('0 0 1 1 *', () => {}, { timezone: 'UTC' });
  task.destroy();

  const sharp = require('sharp');
  assert.equal(typeof sharp, 'function');
  const metadata = await sharp({
    create: { width: 1, height: 1, channels: 4, background: '#00000000' },
  })
    .png()
    .metadata();
  assert.equal(metadata.width, 1);
  assert.equal(metadata.height, 1);
});
