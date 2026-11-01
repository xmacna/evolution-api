// Apply only to the audited rc14 bytes. No network, process startup or auth-state access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MARKER = 'XMACNA_TCTOKEN_ISOLATED_TRANSACTION';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const EXPECTED = {
  'lib/Utils/auth-utils.js': 'd85b07863507235407a3a1430fbb1cfae108c4023f746c50393d9933578caf15',
  'lib/Socket/messages-send.js': '81387f00b457ea28b481b1320bfdbf5ada766305f6f2bc7033931f49811519dc',
  'lib/Types/Auth.d.ts': '509e25a092ba7b4cd9b7be1f8a1730014ea3745fd02cc14e12d9009e4554958e',
};
function once(text, needle, replacement) {
  if (text.split(needle).length !== 2) throw new Error('rc14 anchor missing or ambiguous');
  return text.replace(needle, replacement);
}
function transform(file, text) {
  if (file.endsWith('auth-utils.js')) {
    const start = text.indexOf('export const addTransactionCapability =');
    const prefix = text.slice(0, start);
    let block = text.slice(start);
    block = once(block, '    return {\n        get: async (type, ids) => {',
      '    const transactionalStore = {\n        get: async (type, ids) => {');
    block = once(block, '        isInTransaction,',
      `        // ${MARKER}: response persistence must not reuse a finished send context.\n` +
      '        transactionIsolated: (work, key) => txStorage.exit(() => transactionalStore.transaction(work, key)),\n' +
      '        isInTransaction,');
    block = once(block, '    };\n};\n/**\n * Returns the authenticated user',
      '    };\n    return transactionalStore;\n};\n/**\n * Returns the authenticated user');
    return prefix + block;
  }
  if (file.endsWith('messages-send.js')) {
    text = once(text,
      '                    .then(async (result) => {\n                    await storeTcTokensFromIqResult({',
      `                    // ${MARKER}: IQ stays detached; only its response takes a new transaction.\n` +
      '                    .then((result) => authState.keys.transactionIsolated(async () => {\n' +
      '                    await storeTcTokensFromIqResult({');
    return once(text,
      '                            ...indexWrite\n                        }\n                    });\n                })\n                    .catch(err => {',
      "                            ...indexWrite\n                        }\n                    });\n                }, meId))\n                    .catch(err => {");
  }
  return once(text,
    '    transaction<T>(exec: () => Promise<T>, key: string): Promise<T>;',
    '    transaction<T>(exec: () => Promise<T>, key: string): Promise<T>;\n' +
    `    /** ${MARKER}: starts a fresh transaction outside this store's inherited context. */\n` +
    '    transactionIsolated<T>(exec: () => Promise<T>, key: string): Promise<T>;');
}

function apply(root = path.resolve(__dirname, '../../node_modules/baileys'), { check = false } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== '7.0.0-rc14') throw new Error(`Unsupported Baileys ${version}; review the patch before upgrading`);
  const edits = [];
  for (const [file, digest] of Object.entries(EXPECTED)) {
    const target = path.join(root, file);
    const current = fs.readFileSync(target, 'utf8');
    let baseline = current;
    if (current.includes(MARKER)) {
      // Reconstruct original bytes and compare the full patched file; a marker alone is never enough.
      if (file.endsWith('auth-utils.js')) {
        baseline = once(baseline, '    const transactionalStore = {\n        get: async (type, ids) => {', '    return {\n        get: async (type, ids) => {');
        baseline = once(baseline,
          `        // ${MARKER}: response persistence must not reuse a finished send context.\n` +
          '        transactionIsolated: (work, key) => txStorage.exit(() => transactionalStore.transaction(work, key)),\n', '');
        baseline = once(baseline, '    };\n    return transactionalStore;\n};\n/**\n * Returns the authenticated user', '    };\n};\n/**\n * Returns the authenticated user');
      } else if (file.endsWith('messages-send.js')) {
        baseline = once(baseline,
          `                    // ${MARKER}: IQ stays detached; only its response takes a new transaction.\n` +
          '                    .then((result) => authState.keys.transactionIsolated(async () => {\n',
          '                    .then(async (result) => {\n');
        baseline = once(baseline, "                }, meId))\n                    .catch(err => {", '                })\n                    .catch(err => {');
      } else {
        baseline = once(baseline,
          `\n    /** ${MARKER}: starts a fresh transaction outside this store's inherited context. */\n` +
          '    transactionIsolated<T>(exec: () => Promise<T>, key: string): Promise<T>;', '');
      }
    }
    if (sha(baseline) !== digest) throw new Error(`Unexpected bytes in ${file}; refusing a partial or stale patch`);
    const patched = transform(file, baseline);
    if (current !== baseline && current !== patched) throw new Error(`Invalid patched content in ${file}`);
    if (file.endsWith('.js')) {
      const parsed = spawnSync(process.execPath, ['--input-type=module', '--check'], {
        input: patched, encoding: 'utf8', windowsHide: true,
      });
      if (parsed.status !== 0) throw new Error(`Patched syntax failed in ${file}`);
    }
    if (check && current !== patched) throw new Error(`Patch not installed in ${file}`);
    edits.push({ target, patched, changed: current !== patched });
  }
  // Validate every file before writing any: build failure cannot silently retain only one half.
  if (!check) for (const edit of edits) if (edit.changed) fs.writeFileSync(edit.target, edit.patched);
  return { files: edits.length, changed: check ? 0 : edits.filter((edit) => edit.changed).length };
}
if (require.main === module) {
  try { console.log(JSON.stringify(apply(undefined, { check: process.argv.includes('--check') }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { apply, MARKER };
