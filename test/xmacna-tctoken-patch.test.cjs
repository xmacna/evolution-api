const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { apply } = require('../Docker/scripts/patch-baileys-tctoken.cjs');
const files = ['lib/Utils/auth-utils.js', 'lib/Socket/messages-send.js', 'lib/Types/Auth.d.ts'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xmacna-rc14-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '7.0.0-rc14' }));
  for (const name of files) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../node_modules/baileys', name), target);
  }
  return root;
}
test('a fully installed patch is verified and applying it again writes nothing', (t) => {
  const root = fixture(t);
  assert.deepEqual(apply(root, { check: true }), { files: 3, changed: 0 });
  assert.deepEqual(apply(root), { files: 3, changed: 0 });
});
test('an unexpected byte or fake marker aborts before any file is written', (t) => {
  const root = fixture(t);
  const target = path.join(root, files[1]);
  fs.appendFileSync(target, '\n// unexpected drift\n');
  const before = files.map((file) => fs.readFileSync(path.join(root, file)));
  assert.throws(() => apply(root), /Unexpected bytes|anchor missing/);
  assert.throws(() => apply(root, { check: true }), /Unexpected bytes|anchor missing/);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(root, file)), before[i]));
});
test('a different dependency version is rejected before touching the package', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '7.0.0-next' }));
  assert.throws(() => apply(root), /Unsupported Baileys/);
});
