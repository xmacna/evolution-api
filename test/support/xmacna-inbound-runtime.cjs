// Load focused TypeScript units without starting the application or connecting to a database.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const cache = new Map();
const root = path.resolve(__dirname, '../..');
const baseline = process.env.XMACNA_INBOUND_BASELINE_REF;
if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('Baseline must be a full commit SHA');
function sourceFor(filename) {
  const relative = path.relative(root, filename).split(path.sep).join('/');
  if (baseline && relative.startsWith('src/')) {
    return execFileSync('git', ['show', baseline + ':' + relative], { cwd: root, encoding: 'utf8' });
  }
  return fs.readFileSync(filename, 'utf8');
}

function loadTs(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const source = ts.transpileModule(sourceFor(filename), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = (id) => {
    if (id === '@prisma/client') return { Prisma: {} }; // No repository method is exercised.
    if (id.startsWith('.')) return loadTs(path.relative(root, path.resolve(path.dirname(filename), id + '.ts')));
    return require(id);
  };
  vm.runInThisContext('(function(require, module, exports) {' + source + '\n})', { filename })(
    localRequire, module, module.exports,
  );
  return module.exports;
}

function loadRecoveryMethod(dependencies) {
  const filename = path.join(root, 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');
  const source = ts.createSourceFile(filename, sourceFor(filename), ts.ScriptTarget.Latest, true);
  let method;
  const visit = (node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'dispatchRecoveredInbound') method = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!method) throw new Error('Recovery method not found');
  // The complete production method is copied mechanically, with no body substitutions.
  const code = ts.transpileModule('class RecoveryHarness {' + method.getText(source) + '}', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(code + '\nRecoveryHarness.prototype.dispatchRecoveredInbound', {
    ...dependencies, setInterval, clearInterval,
  });
}
module.exports = { loadTs, loadRecoveryMethod };
