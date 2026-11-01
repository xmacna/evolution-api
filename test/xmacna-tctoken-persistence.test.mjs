import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { createClient } from 'redis';

const require = createRequire(import.meta.url);
const baileysLib = dirname(require.resolve('baileys'));
const { addTransactionCapability, makeCacheableSignalKeyStore } = await import(
  pathToFileURL(join(baileysLib, 'Utils/auth-utils.js'))
);
const { useMultiFileAuthState } = await import(pathToFileURL(join(baileysLib, 'Utils/use-multi-file-auth-state.js')));
const { resolveIssuanceJid, storeTcTokensFromIqResult, buildMergedTcTokenIndexWrite, readTcTokenIndex } = await import(
  pathToFileURL(join(baileysLib, 'Utils/tc-token-utils.js'))
);
const logger = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map((key) => [key, () => {}]));
const source = await readFile(join(baileysLib, 'Socket/messages-send.js'), 'utf8');
const start = source.indexOf('resolveIssuanceJid(destinationJid, sock.serverProps.lidTrustedTokenIssueToLid');
const end = source.indexOf('\n            }\n            // Add message to retry cache', start);
assert(start >= 0 && end > start, 'rc14 issuance chain must be found, never silently skipped');
// Execute the deployed issuance chain without constructing a socket. Only the IQ transport is replaced.
const issue = new Function(
  'authState', 'issuePrivacyTokens', 'resolveIssuanceJid', 'storeTcTokensFromIqResult',
  'buildMergedTcTokenIndexWrite', 'logger', 'tcTokenJid', 'issueTimestamp', 'inFlightTcTokenIssuance',
  `const destinationJid=tcTokenJid,meId='synthetic-owner',getLIDForPN=async jid=>jid,getPNForLID=async jid=>jid;
   const sock={serverProps:{lidTrustedTokenIssueToLid:true}};return ${source.slice(start, end).trim()}`,
);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function layers(store) {
  return addTransactionCapability(makeCacheableSignalKeyStore(store, logger), logger, {
    maxCommitRetries: 1, delayBetweenTriesMs: 1,
  });
}
function response(token, timestamp) {
  return { tag: 'iq', attrs: {}, content: [{ tag: 'tokens', attrs: {}, content: [
    { tag: 'token', attrs: { type: 'trusted_contact', t: String(timestamp) }, content: token },
  ] }] };
}
function schedule(keys, iq, jid, timestamp, inFlight = new Set([jid])) {
  return issue({ keys }, () => iq.promise, resolveIssuanceJid, storeTcTokensFromIqResult,
    buildMergedTcTokenIndexWrite, logger, jid, timestamp, inFlight);
}

async function fileKeys(t) {
  const folder = await mkdtemp(join(tmpdir(), 'xmacna-tctoken-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const open = async () => layers((await useMultiFileAuthState(folder)).state.keys);
  return { keys: await open(), open };
}

test('cold token issued after send commit survives real cache and file-store recreation', { timeout: 5000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'xmacna-tctoken-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const initial = await useMultiFileAuthState(folder);
  const keys = layers(initial.state.keys);
  const jid = '991234@lid';
  const timestamp = Math.floor(Date.now() / 1000);
  const token = Buffer.from('synthetic-trusted-contact-token');
  assert.equal((await keys.get('tctoken', [jid]))[jid], undefined);
  const iq = deferred();
  let pending;
  await keys.transaction(async () => {
    pending = schedule(keys, iq, jid, timestamp);
    await keys.set({ tctoken: { 'unrelated@lid': { token: Buffer.from('keep'), timestamp: String(timestamp) } } });
  }, 'synthetic-owner');
  // The send transaction is already complete, even though the IQ has no response yet.
  iq.resolve(response(token, timestamp));
  await pending;
  const live = (await keys.get('tctoken', [jid]))[jid];
  assert.ok(live, 'late token must reach the live store, not only a retired transaction buffer');
  assert.deepEqual(live.token, token);
  const reopened = await useMultiFileAuthState(folder);
  const cold = layers(reopened.state.keys); // New cache, new provider, same durable backing files.
  const persisted = (await cold.get('tctoken', [jid]))[jid];
  assert.deepEqual(persisted?.token, token, 'token must survive provider and cache recreation');
  assert.equal(persisted.timestamp, String(timestamp));
  assert.equal(persisted.senderTimestamp, timestamp);
  assert.ok((await readTcTokenIndex(cold)).includes(jid), 'token index must also persist');
  assert.equal((await cold.get('tctoken', ['unrelated@lid']))['unrelated@lid'].token.toString(), 'keep');
});

test('concurrent late issuances preserve all tokens and the shared index after recreation', { timeout: 5000 }, async (t) => {
  const { keys, open } = await fileKeys(t);
  const timestamp = Math.floor(Date.now() / 1000);
  const jobs = Array.from({ length: 16 }, (_, i) => ({ jid: `99${i + 100}@lid`, iq: deferred() }));
  const pending = [];
  await keys.transaction(async () => {
    for (const job of jobs) pending.push(schedule(keys, job.iq, job.jid, timestamp));
  }, 'synthetic-owner');
  for (const job of jobs) job.iq.resolve(response(Buffer.from(job.jid), timestamp));
  await Promise.all(pending);
  const cold = await open();
  const index = await readTcTokenIndex(cold);
  assert.deepEqual(index.sort(), jobs.map(({ jid }) => jid).sort());
  for (const { jid } of jobs) assert.equal((await cold.get('tctoken', [jid]))[jid].token.toString(), jid);
});

test('a stale issuance response preserves a newer token already in the durable store', { timeout: 5000 }, async (t) => {
  const { keys, open } = await fileKeys(t);
  const jid = '991235@lid', timestamp = Math.floor(Date.now() / 1000), iq = deferred();
  let pending;
  await keys.transaction(async () => { pending = schedule(keys, iq, jid, timestamp); }, 'synthetic-owner');
  await keys.set({ tctoken: { [jid]: { token: Buffer.from('newer'), timestamp: String(timestamp + 1) } } });
  iq.resolve(response(Buffer.from('older'), timestamp));
  await pending;
  const cold = await open();
  assert.equal((await cold.get('tctoken', [jid]))[jid].token.toString(), 'newer');
});

test('IQ failure releases the in-flight guard and a subsequent response can persist', { timeout: 5000 }, async (t) => {
  const { keys, open } = await fileKeys(t);
  const jid = '991236@lid', timestamp = Math.floor(Date.now() / 1000), failed = deferred();
  const inFlight = new Set([jid]);
  let pending;
  await keys.transaction(async () => { pending = schedule(keys, failed, jid, timestamp, inFlight); }, 'synthetic-owner');
  failed.reject(new Error('synthetic IQ timeout'));
  await pending;
  assert.equal(inFlight.size, 0);
  assert.equal((await (await open()).get('tctoken', [jid]))[jid], undefined);
  const retry = deferred();
  inFlight.add(jid);
  await keys.transaction(async () => { pending = schedule(keys, retry, jid, timestamp, inFlight); }, 'synthetic-owner');
  retry.resolve(response(Buffer.from('retry'), timestamp));
  await pending;
  assert.equal(inFlight.size, 0);
  assert.equal((await (await open()).get('tctoken', [jid]))[jid].token.toString(), 'retry');
});

test('a prompt response cannot be overwritten by the sending transaction expiry cleanup', { timeout: 5000 }, async (t) => {
  const { keys, open } = await fileKeys(t);
  const jid = '991237@lid', timestamp = Math.floor(Date.now() / 1000), iq = deferred();
  let pending;
  await keys.transaction(async () => {
    await keys.set({ tctoken: { [jid]: { token: Buffer.alloc(0), senderTimestamp: timestamp - 1 } } });
    pending = schedule(keys, iq, jid, timestamp);
    iq.resolve(response(Buffer.from('prompt'), timestamp));
    // A slow outer commit must not wipe a response that finished earlier.
    await new Promise((resolve) => setTimeout(resolve, 30));
  }, 'synthetic-owner');
  await pending;
  assert.equal((await (await open()).get('tctoken', [jid]))[jid].token.toString(), 'prompt');
});

test('regular nested transactions keep their original atomic behavior', { timeout: 5000 }, async (t) => {
  const { keys, open } = await fileKeys(t);
  await assert.rejects(keys.transaction(async () => {
    await keys.transaction(async () => {
      await keys.set({ tctoken: { '991238@lid': { token: Buffer.from('must-rollback'), timestamp: '1' } } });
    }, 'nested-owner');
    throw new Error('synthetic abort');
  }, 'outer-owner'), /synthetic abort/);
  assert.equal((await (await open()).get('tctoken', ['991238@lid']))['991238@lid'], undefined);
});

test('late issuance persists through the actual Evolution Redis provider and cache classes', {
  skip: !process.env.XMACNA_TCTOKEN_REDIS_URL, timeout: 15000,
}, async (t) => {
  const url = new URL(process.env.XMACNA_TCTOKEN_REDIS_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'integration requires an isolated local Redis');
  const admin = createClient({ url: url.href });
  admin.on('error', () => {});
  await admin.connect();
  let redis, fixtureKey, session;
  t.after(async () => {
    if (fixtureKey) await admin.del(fixtureKey);
    if (redis?.isOpen) await redis.quit();
    await admin.quit();
    if (session) await rm(join(process.cwd(), 'instances', session), { recursive: true, force: true });
  });
  assert.ok(Number(url.port) >= 1024 && url.port !== '6379', 'use the dedicated test Redis port');
  process.env.CACHE_REDIS_ENABLED = 'true';
  process.env.CACHE_REDIS_URI = url.href;
  process.env.CACHE_REDIS_PREFIX_KEY = 'xmacna-tctoken-test';
  process.env.CACHE_REDIS_TTL = '600';
  process.env.LOG_LEVEL = 'ERROR';
  const folder = join(process.cwd(), '.local', 'tctoken-provider-test');
  await mkdir(folder, { recursive: true });
  const output = join(folder, 'provider.cjs');
  const compiled = await build({
    stdin: {
      contents: `export { default as open } from './src/utils/use-multi-file-auth-state-prisma';
        export { CacheService } from './src/api/services/cache.service';
        export { RedisCache } from './src/cache/rediscache';
        export { configService } from './src/config/env.config';
        export { redisClient } from './src/cache/rediscache.client';`,
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{
      name: 'isolate-credential-repository-only', setup(build) {
        build.onResolve({ filter: /^@api\/server\.module$/ }, () => ({ path: 'credential-fixture', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `export const prismaRepository={session:{findUnique:async()=>({creds:JSON.stringify('{}')})}};`, loader: 'js',
        }));
      },
    }],
  });
  await writeFile(output, compiled.outputFiles[0].contents);
  const provider = require(output);
  redis = provider.redisClient.getConnection();
  session = `synthetic-${process.pid}`;
  const cache = () => new provider.CacheService(new provider.RedisCache(provider.configService, 'tctoken-fixture'));
  const open = async () => layers((await provider.open(session, cache())).state.keys);
  const keys = await open(), iq = deferred(), jid = '991239@lid', timestamp = Math.floor(Date.now() / 1000);
  let pending;
  assert.equal((await keys.get('tctoken', [jid]))[jid], undefined);
  await keys.transaction(async () => { pending = schedule(keys, iq, jid, timestamp); }, 'synthetic-owner');
  iq.resolve(response(Buffer.from('redis-token'), timestamp));
  await pending;
  const cold = await open();
  assert.equal((await cold.get('tctoken', [jid]))[jid].token.toString(), 'redis-token');
  assert.ok((await readTcTokenIndex(cold)).includes(jid));
  const jobs = Array.from({ length: 16 }, (_, i) => ({ jid: `98${i + 100}@lid`, iq: deferred() }));
  const pendingBatch = [];
  await cold.transaction(async () => {
    for (const job of jobs) pendingBatch.push(schedule(cold, job.iq, job.jid, timestamp));
  }, 'synthetic-owner');
  for (const job of jobs) job.iq.resolve(response(Buffer.from(job.jid), timestamp));
  await Promise.all(pendingBatch);
  const recreated = await open();
  assert.deepEqual((await readTcTokenIndex(recreated)).sort(), [jid, ...jobs.map((job) => job.jid)].sort());
  for (const job of jobs) {
    assert.equal((await recreated.get('tctoken', [job.jid]))[job.jid].token.toString(), job.jid);
  }
  // Inspect only this fixture's backing hash, never flush a database or touch another namespace.
  const engine = new provider.RedisCache(provider.configService, 'tctoken-fixture');
  fixtureKey = engine.buildKey(session);
  assert.equal(await admin.hLen(engine.buildKey(session)), 18);
});
