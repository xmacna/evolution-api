// Regression: Meta status callbacks whose contacts lack profile/name must not abort messageHandle before statuses.
// Executes the PRODUCTION BusinessStartupService.messageHandle from the REAL source of this checkout (patched) and,
// as regression evidence, from the baseline blob 5955acd0 = image revision (git show, in memory, read-only). Only the import block is
// replaced by limited stubs (test/helpers/meta-profile-stubs.mjs); the class body is byte-identical to the source
// (line endings normalized CRLF->LF only). No network: the axios stub counts calls and every case requires 0.
//
// Run (Node >= 22.7, no node_modules needed):
//   node --experimental-transform-types --no-warnings test/xmacna-meta-profile-optional.test.mjs
// Env: META_PROFILE_OUT=<dir> keeps generated .mts/RESULTS.json there (default: a temp dir, removed at the end);
//      META_PROFILE_PATCHED_REF=<git ref> loads the "patched" variant from a ref instead of the working tree (self-check).
// Cleanup: only a temp dir created here (os.tmpdir()/meta-profile-*) is ever removed; a META_PROFILE_OUT dir is never deleted.
// Exit code 0 ONLY if: patched = 7 PASS / 0 FAIL AND baseline = exactly the expected 3 PASS / 4 FAIL pattern.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process'; import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REL = 'src/api/integrations/channel/meta/whatsapp.business.service.ts';
// Baseline = revision labelled on the running primary image (org.opencontainers revision 5955acd0, v2.3.7).
const BASELINE_REF = '5955acd0eb15d9c25659f6716fe6c40dde07aa2b';
const STUBS = pathToFileURL(path.join(REPO, 'test', 'helpers', 'meta-profile-stubs.mjs')).href;
const MARK = 'export class BusinessStartupService';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const lf = (s) => s.replace(/\r\n/g, '\n');
const gitShow = (ref) => execFileSync('git', ['show', `${ref}:${REL}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 << 20 });

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const OUT = process.env.META_PROFILE_OUT ? path.resolve(process.env.META_PROFILE_OUT) : fs.mkdtempSync(path.join(TMP_ROOT, 'meta-profile-'));
const KEEP = !!process.env.META_PROFILE_OUT;
fs.mkdirSync(OUT, { recursive: true });

function build(name, text) {
  const src = lf(text); const i = src.indexOf(MARK); if (i < 0) throw new Error('class marker missing in ' + name);
  const header = src.slice(0, i); const cls = src.slice(i); const names = new Set();
  for (const m of header.matchAll(/import\s+([\s\S]*?)\s+from\s+'[^']+';/g)) {
    const spec = m[1].trim();
    const ns = spec.match(/^\*\s+as\s+(\w+)$/); if (ns) { names.add(ns[1]); continue; }
    const def = spec.match(/^(\w+)\s*(,|$)/); if (def) names.add(def[1]);
    const br = spec.match(/\{([\s\S]*)\}/); if (br) br[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => names.add(n.split(/\s+as\s+/).pop()));
  }
  const prelude = `import { __stub } from ${JSON.stringify(STUBS)};\n` + [...names].map((n) => `const ${n} = __stub(${JSON.stringify(n)});`).join('\n') + '\n';
  const file = path.join(OUT, name + '.mts'); fs.writeFileSync(file, prelude + cls);
  return { file, source_sha256_lf: sha(src), class_body_sha256: sha(cls) };
}

const ID = 'wamid.SYNTHETIC-TEST-ID';
const statusPayload = (st, contacts) => ({ metadata: { phone_number_id: 'PNID-TEST' }, ...(contacts === undefined ? {} : { contacts }),
  statuses: [{ id: ID, status: st, recipient_id: 'RCPT-TEST', timestamp: '1700000000' }] });
const CASES = [
  { name: 'status delivered, contacts[{wa_id}] without profile', p: statusPayload('delivered', [{ wa_id: 'RCPT-TEST' }]), expect: { update: 'DELIVERED' }, baseline: false },
  { name: 'status read, contacts[{wa_id}] without profile', p: statusPayload('read', [{ wa_id: 'RCPT-TEST' }]), expect: { update: 'READ' }, baseline: false },
  { name: 'status delivered, contacts absent', p: statusPayload('delivered', undefined), expect: { update: 'DELIVERED' }, baseline: true },
  { name: 'status read, contacts empty []', p: statusPayload('read', []), expect: { update: 'READ' }, baseline: false },
  { name: 'status delivered, profile without name', p: statusPayload('delivered', [{ wa_id: 'RCPT-TEST', profile: {} }]), expect: { update: 'DELIVERED' }, baseline: true },
  { name: 'status for UNKNOWN id persists nothing (id guard kept)', p: { metadata: { phone_number_id: 'PNID-TEST' }, contacts: [{ wa_id: 'RCPT-TEST' }],
      statuses: [{ id: 'wamid.NOT-OURS', status: 'delivered', recipient_id: 'RCPT-TEST' }] }, expect: { noUpdate: true }, baseline: false },
  { name: 'inbound text keeps valid profile.name', p: { metadata: { phone_number_id: 'PNID-TEST' }, contacts: [{ wa_id: 'FROM-TEST', profile: { name: 'Nome Sintetico' } }],
      messages: [{ id: 'wamid.SYNTHETIC-IN', from: 'FROM-TEST', type: 'text', text: { body: 'texto sintetico' }, timestamp: '1700000001' }] }, expect: { pushName: 'Nome Sintetico' }, baseline: true },
];

async function runVariant(name, text) {
  const b = build(name, text); const mod = await import(pathToFileURL(b.file).href); const results = [];
  for (const c of CASES) {
    const rec = { updates: [], messagesCreated: [], errors: [] }; globalThis.__AXIOS_CALLS = 0;
    const prisma = {
      message: { findFirst: async (q) => (q?.where?.key?.equals === ID ? { id: 'msg-row-1', webhookUrl: null } : null), create: async (x) => { rec.messagesCreated.push(x.data); return x.data; } },
      messageUpdate: { create: async (x) => { rec.updates.push(x.data); return x.data; } },
      contact: { findFirst: async () => null, create: async () => ({}), updateMany: async () => ({}) },
      chat: { findFirst: async () => null, create: async () => ({}), upsert: async () => ({}) },
    };
    const cfg = { get: (k) => (k === 'CHATWOOT' ? { ENABLED: false } : k === 'S3' ? { ENABLE: false } : k === 'OPENAI' ? { ENABLED: false } : {}) };
    const svc = new mod.BusinessStartupService(cfg, { emit() {} }, prisma, {}, {}, {}, {});
    Object.assign(svc, { instanceId: 'inst-test', phoneNumber: 'PHONE-TEST@s.whatsapp.net', instance: { name: 'hermes-test' }, localChatwoot: undefined,
      localSettings: { readMessages: false }, localWebhook: { enabled: false }, sendDataWebhook: () => {},
      logger: { log() {}, info() {}, warn() {}, verbose() {}, debug() {}, error: (e) => rec.errors.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) } });
    let threw = null; try { await svc.messageHandle(c.p, {}, {}); } catch (e) { threw = `${e.name}: ${e.message}`; }
    const ok = !threw && rec.errors.length === 0 && globalThis.__AXIOS_CALLS === 0;
    let pass;
    if (c.expect.noUpdate) pass = ok && rec.updates.length === 0;
    else if (c.expect.update) pass = ok && rec.updates.length === 1 && rec.updates[0].keyId === ID && rec.updates[0].status === c.expect.update && rec.updates[0].messageId === 'msg-row-1';
    else pass = ok && rec.messagesCreated.length === 1 && rec.messagesCreated[0].pushName === c.expect.pushName;
    results.push({ case: c.name, pass, expected_on_baseline: c.baseline, error: rec.errors[0] || threw, updates: rec.updates.map((u) => ({ keyId: u.keyId, status: u.status })), axios_calls: globalThis.__AXIOS_CALLS });
  }
  return { variant: name, source_sha256_lf: b.source_sha256_lf, class_body_sha256: b.class_body_sha256, results };
}

const patchedRef = process.env.META_PROFILE_PATCHED_REF || null;
const patchedText = patchedRef ? gitShow(patchedRef) : fs.readFileSync(path.join(REPO, REL), 'utf8');
const baseline = await runVariant('baseline-5955acd', gitShow(BASELINE_REF));
const patched = await runVariant(patchedRef ? 'patched-ref-' + patchedRef.slice(0, 12) : 'patched-worktree', patchedText);
const baselinePatternOk = baseline.results.every((r) => r.pass === r.expected_on_baseline)
  && baseline.results.filter((r) => !r.pass).every((r) => /TypeError: Cannot read properties of undefined \(reading '(name|profile)'\)/.test(r.error || ''));
const patchedOk = patched.results.every((r) => r.pass);
const summary = { at: new Date().toISOString(), node: process.version, network: false, baseline_ref: BASELINE_REF, patched_from: patchedRef || 'working tree',
  baseline: { pass: baseline.results.filter((r) => r.pass).length, fail: baseline.results.filter((r) => !r.pass).length, pattern_as_expected: baselinePatternOk },
  patched: { pass: patched.results.filter((r) => r.pass).length, fail: patched.results.filter((r) => !r.pass).length },
  variants: [baseline, patched] };
for (const v of summary.variants) for (const r of v.results) console.log(`${v.variant.padEnd(22)} ${r.pass ? 'PASS' : 'FAIL'}  ${r.case}${r.error ? '  err=' + r.error : ''}`);
console.log(`baseline ${summary.baseline.pass} PASS / ${summary.baseline.fail} FAIL (expected 3/4, pattern ${baselinePatternOk ? 'OK' : 'CHANGED'}); patched ${summary.patched.pass} PASS / ${summary.patched.fail} FAIL (required 7/0)`);
function safeCleanup(dir) {
  const real = fs.realpathSync(dir);
  if (KEEP || path.dirname(real) !== TMP_ROOT || !/^meta-profile-[A-Za-z0-9]{6}$/.test(path.basename(real))) throw new Error('refusing to remove ' + real);
  fs.rmSync(real, { recursive: true, force: true });
}
if (KEEP) fs.writeFileSync(path.join(OUT, 'RESULTS.json'), JSON.stringify(summary, null, 2) + '\n'); else safeCleanup(OUT);
process.exitCode = baselinePatternOk && patchedOk && summary.patched.pass === 7 ? 0 : 1;
