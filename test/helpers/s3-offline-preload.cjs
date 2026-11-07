// Isolate the exception -> router import cycle without replacing S3, the SDK,
// config, logger or exception classes. Exceptions only consume HttpStatus.
// Derive that enum from the real source; loading the router would initialize
// unrelated WhatsApp providers during a storage-only contract test.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const router = path.resolve(__dirname, '../../src/api/routes/index.router.ts');
const source = fs.readFileSync(router, 'utf8');
const declaration = source.match(/\benum HttpStatus\s*\{([^}]+)\}/);
if (!declaration) throw new Error('HttpStatus enum boundary changed');
const entries = [...declaration[1].matchAll(/([A-Z_]+)\s*=\s*(\d+)\s*,?/g)];
if (entries.length !== 7) throw new Error('HttpStatus enum shape changed');
const HttpStatus = Object.fromEntries(entries.map(([, name, value]) => [name, Number(value)]));
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@api/routes/index.router' && /[\\/]src[\\/]exceptions[\\/]/.test(parent?.filename || '')) {
    return { HttpStatus };
  }
  return load.call(this, request, parent, isMain);
};

// Any unexpected network path must fail rather than reaching a real service.
const deny = () => {
  throw new Error('NEX-OFFLINE-NETWORK-DENIED');
};
for (const name of ['node:http', 'node:https']) {
  const api = require(name);
  api.request = deny;
  api.get = deny;
}
const net = require('node:net');
const os = require('node:os');
const tsxPipe = `\\\\?\\pipe\\${path.join(os.tmpdir(), `tsx-${os.userInfo().username}`, `${process.ppid}.pipe`)}`;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const pipe = typeof options === 'string' ? options : options?.path;
  // tsx notifies its parent through this exact local pipe. It is not TCP.
  if (process.platform !== 'win32' || pipe !== tsxPipe) return deny();
  return connect.apply(this, args);
};
