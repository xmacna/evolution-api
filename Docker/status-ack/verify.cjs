// Offline verification after npm ci, or against a separately extracted, integrity-checked npm archive.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readSource, sha, transform } = require('./patch.cjs');
const pins = require('./source.json');

const repo = path.resolve(__dirname, '../..');
const root = path.resolve(process.env.BAILEYS_AUDITED_ROOT || path.join(repo, 'node_modules/baileys'));
const pkg = require(path.join(repo, 'package.json'));
const lock = require(path.join(repo, 'package-lock.json'));
assert.equal(pkg.dependencies.baileys, pins.version, 'Baileys version drift');
for (const key of ['version', 'resolved', 'integrity']) {
  assert.equal(lock.packages['node_modules/baileys'][key], pins[key], 'Baileys lockfile drift: ' + key);
}
const original = readSource(root);
assert.equal(sha(transform(original)), pins.patchedSha256, 'candidate byte drift');

function run(file, baseline, expectedPass, expectedFail) {
  const env = { ...process.env, BAILEYS_AUDITED_ROOT: root };
  delete env.STATUS_ACK_TEST_BASELINE;
  if (baseline) env.STATUS_ACK_TEST_BASELINE = '1';
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', '--test-reporter=tap', path.join(__dirname, file)],
    { env, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.signal, null, 'test process terminated by signal');
  assert.equal(result.status, baseline ? 1 : 0, 'unexpected test exit: ' + file);
  const count = (key) => {
    const match = result.stdout.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'));
    assert.ok(match, 'missing TAP total: ' + key);
    return Number(match[1]);
  };
  const totals = { pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') };
  assert.equal(totals.pass, expectedPass);
  assert.equal(totals.fail, expectedFail);
  assert.equal(totals.cancelled, 0);
  assert.equal(totals.skipped, 0);
  if (baseline) {
    const failures = [...result.stdout.matchAll(/^not ok (\d+) - /gm)].map((match) => Number(match[1]));
    assert.deepEqual(failures, [2, 3, 4, 5], 'baseline failed outside the four Status cases');
  }
  return totals;
}

const baseline = run('test.cjs', true, 2, 4);
const candidate = run('test.cjs', false, 6, 0);
const guards = run('patch.test.cjs', false, 8, 0);
const evidence = run('canary-evidence.test.cjs', false, 15, 0);

// Exercise the real build CLI against a disposable copy, keeping the audited source read-only.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-ack-build-'));
try {
  for (const file of ['package.json', ...Object.keys(pins.files)]) {
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  const patched = spawnSync(process.execPath, [path.join(__dirname, 'patch.cjs'), temp, '--apply'], {
    encoding: 'utf8',
  });
  assert.equal(patched.status, 0, patched.stderr);
  const file = path.join(temp, 'lib/Socket/messages-recv.js');
  assert.equal(sha(fs.readFileSync(file)), pins.patchedSha256);
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(
  'STATUS_ACK_PROOF ' +
    JSON.stringify({
      node: process.version,
      source: pins.resolved,
      sourceSha256: sha(original),
      patchedSha256: pins.patchedSha256,
      baseline,
      candidate,
      guards,
      evidence,
      buildCliAndSyntax: 'PASS',
      dockerBuild: 'NOT_RUN',
      realCanary: 'PENDING',
    }),
);
