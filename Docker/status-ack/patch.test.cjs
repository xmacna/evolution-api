'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { transform, readSource, sha, MARKER } = require('./patch.cjs');
const pins = require('./source.json');
const root = process.env.BAILEYS_AUDITED_ROOT;
assert.ok(root, 'BAILEYS_AUDITED_ROOT is required');
const original = readSource(root);

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-ack-guard-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const file of ['package.json', ...Object.keys(pins.files)]) {
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  return { root: temp, file: path.join(temp, 'lib/Socket/messages-recv.js') };
}
const cli = (root, ...args) =>
  spawnSync(process.execPath, [path.join(__dirname, 'patch.cjs'), root, ...args], { encoding: 'utf8' });

test('transform preserves the exact reviewed candidate and single anchors', () => {
  const result = transform(original);
  assert.equal(sha(result), pins.patchedSha256);
  assert.equal(result.split(MARKER).length, 2);
  assert.equal(result.split("ws.on('CB:status'").length, 2);
  assert.equal(result.split("['status', handleStatus]").length, 2);
});
test('dry run leaves audited bytes untouched', (t) => {
  const f = fixture(t);
  const r = cli(f.root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).applied, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});
test('build CLI applies exactly the reviewed bytes', (t) => {
  const f = fixture(t);
  const r = cli(f.root, '--apply');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).after, pins.patchedSha256);
  assert.equal(sha(fs.readFileSync(f.file)), pins.patchedSha256);
});
test('drift fails before writing', (t) => {
  const f = fixture(t);
  const changed = original + '\n';
  fs.writeFileSync(f.file, changed);
  assert.notEqual(cli(f.root, '--apply').status, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), changed);
});
test('repeat application fails without altering candidate', (t) => {
  const f = fixture(t);
  assert.equal(cli(f.root, '--apply').status, 0);
  const applied = fs.readFileSync(f.file);
  assert.notEqual(cli(f.root, '--apply').status, 0);
  assert.deepEqual(fs.readFileSync(f.file), applied);
});
test('package version drift fails before writing', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = '7.0.0-rc15';
  fs.writeFileSync(file, JSON.stringify(pkg));
  assert.notEqual(cli(f.root, '--apply').status, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});
test('queue or ACK-builder drift fails before writing', (t) => {
  for (const file of ['lib/Utils/offline-node-processor.js', 'lib/Utils/stanza-ack.js']) {
    const f = fixture(t);
    fs.appendFileSync(path.join(f.root, file), '\n');
    assert.notEqual(cli(f.root, '--apply').status, 0);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  }
});
test('missing or duplicate anchors fail closed', () => {
  const anchor = '    // recv a message\n';
  assert.throws(() => transform(original.replace(anchor, '')), /Unreviewed/);
  assert.throws(() => transform(original.replace(anchor, anchor + anchor)), /Unreviewed/);
});
