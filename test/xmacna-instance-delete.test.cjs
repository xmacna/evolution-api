// Exercise the real transpiled classes without importing the application's service graph.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const { EventEmitter2 } = require('eventemitter2');

class FixtureHttpError extends Error {}
class FixtureLogger {
  warn() {}
  error() {}
  info() {}
}
const forbiddenIO = () => {
  throw new Error('Real persistence, process or filesystem I/O forbidden in this fixture');
};
const events = {
  INSTANCE_DELETE: 'instance.delete',
  REMOVE_INSTANCE: 'remove.instance',
  LOGOUT_INSTANCE: 'logout.instance',
};
const stubs = {
  '@api/server.module': { channelController: {}, eventManager: {} },
  '@api/types/wa.types': { Events: events, Integration: { WHATSAPP_BAILEYS: 'WHATSAPP-BAILEYS' } },
  '@config/logger.config': { Logger: FixtureLogger },
  '@config/path.config': { INSTANCE_DIR: '/fixture-only', STORE_DIR: '/fixture-only' },
  '@exceptions': {
    BadRequestException: FixtureHttpError,
    InternalServerErrorException: FixtureHttpError,
    NotFoundException: FixtureHttpError,
    UnauthorizedException: FixtureHttpError,
  },
  '@api/integrations/channel/whatsapp/inboundInbox': {},
  child_process: { execFileSync: forbiddenIO },
  fs: { rmSync: forbiddenIO },
  path: require('node:path'),
  baileys: { delay: forbiddenIO },
  'class-validator': {},
  uuid: { v4: () => 'fixture-id' },
};

function loadClass(file, name) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText, diagnostics } = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  assert.equal(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  vm.runInNewContext(
    outputText,
    {
      module,
      exports: module.exports,
      require: (id) => {
        assert.ok(Object.hasOwn(stubs, id), 'Unexpected application import: ' + id);
        return stubs[id];
      },
      setTimeout: forbiddenIO,
      clearTimeout: () => {},
    },
    { filename: file },
  );
  return module.exports[name];
}
const Monitor = loadClass('src/api/services/monitor.service.ts', 'WAMonitoringService');
const Controller = loadClass('src/api/controllers/instance.controller.ts', 'InstanceController');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const emitter = new EventEmitter2();
  const config = {
    get: (key) =>
      ({
        DATABASE: { SAVE_DATA: { INSTANCE: true } },
        CACHE: { REDIS: {} },
        PROVIDER: { ENABLED: false },
        CHATWOOT: { ENABLED: false },
      })[key],
  };
  const monitor = new Monitor(emitter, config, {}, {}, {}, {}, {});
  const log = [];
  monitor.waInstances.target = {
    connectionStatus: { state: 'close' },
    instanceId: 'target-id',
    sendDataWebhook: async (event) => {
      log.push(event);
    },
  };
  const other = { connectionStatus: { state: 'open' } };
  monitor.waInstances.other = other;
  monitor.cleaningUp = async (name) => {
    log.push('sessions:' + name);
  };
  monitor.cleaningStoreData = async (name) => {
    log.push('store:' + name);
  };
  const controller = new Controller(monitor, config, {}, emitter);
  return { emitter, monitor, controller, other, log };
}

test('DELETE response waits until persistent cleanup completes', async (t) => {
  const f = fixture(),
    started = deferred(),
    finish = deferred();
  f.monitor.cleaningStoreData = () => {
    started.resolve();
    return finish.promise;
  };
  let responded = false;
  const deleting = f.controller.deleteInstance({ instanceName: 'target' }).then((value) => {
    responded = true;
    return value;
  });
  t.after(async () => {
    finish.resolve();
    await deleting;
  });
  await started.promise;
  await Promise.resolve();
  assert.equal(responded, false, 'success must not precede release of the persistent name');
  finish.resolve();
  assert.equal((await deleting).status, 'SUCCESS');
});

test('session cleanup completes before persistent deletion starts', async (t) => {
  const f = fixture(),
    started = deferred(),
    finish = deferred();
  f.monitor.cleaningUp = () => {
    started.resolve();
    return finish.promise;
  };
  let storeStarted = false;
  f.monitor.cleaningStoreData = async () => {
    storeStarted = true;
  };
  const removing = f.emitter.emitAsync('remove.instance', 'target', 'inner');
  t.after(async () => {
    finish.resolve();
    await removing;
  });
  await started.promise;
  assert.equal(storeStarted, false, 'cleanup must not race the record deletion');
  finish.resolve();
  await removing;
  assert.equal(storeStarted, true);
});

test('live registry entry remains until persistent deletion finishes', async (t) => {
  const f = fixture(),
    started = deferred(),
    finish = deferred();
  f.monitor.cleaningStoreData = () => {
    started.resolve();
    return finish.promise;
  };
  const removing = f.emitter.emitAsync('remove.instance', 'target', 'inner');
  t.after(async () => {
    finish.resolve();
    await removing;
  });
  await started.promise;
  assert.ok(f.monitor.waInstances.target);
  finish.resolve();
  await removing;
  assert.equal(f.monitor.waInstances.target, undefined);
  assert.equal(f.monitor.waInstances.other, f.other);
});

test('persistent cleanup failure rejects DELETE instead of reporting success', async () => {
  const f = fixture(),
    started = deferred(),
    finish = deferred();
  finish.promise.catch(() => {}); // Consume the deliberately ignored baseline promise too.
  f.monitor.cleaningStoreData = () => {
    started.resolve();
    return finish.promise;
  };
  const deleting = f.controller.deleteInstance({ instanceName: 'target' });
  await started.promise;
  finish.reject(new Error('synthetic persistent cleanup failure'));
  await assert.rejects(deleting, /synthetic persistent cleanup failure/);
  assert.ok(f.monitor.waInstances.target);
  assert.equal(f.monitor.waInstances.other, f.other);
});

test('successful DELETE completes both cleanup stages once and only removes its instance', async () => {
  const f = fixture();
  const response = await f.controller.deleteInstance({ instanceName: 'target' });
  assert.equal(response.status, 'SUCCESS');
  assert.deepEqual(f.log, ['instance.delete', 'remove.instance', 'sessions:target', 'store:target']);
  assert.equal(f.monitor.waInstances.target, undefined);
  assert.equal(f.monitor.waInstances.other, f.other);
});

test('a caller awaiting the removal event observes the same failure', async () => {
  const f = fixture();
  const failure = Promise.reject(new Error('synthetic session cleanup failure'));
  failure.catch(() => {});
  f.monitor.cleaningUp = () => failure;
  await assert.rejects(f.emitter.emitAsync('remove.instance', 'target', 'inner'), /synthetic session cleanup failure/);
  assert.ok(f.monitor.waInstances.target);
  assert.equal(f.log.includes('store:target'), false);
});

test('open and connecting instances finish logout before the removal stages', async () => {
  for (const state of ['open', 'connecting']) {
    const f = fixture();
    f.monitor.waInstances.target.connectionStatus.state = state;
    f.monitor.waInstances.target.logoutInstance = async () => {
      f.log.push('logout');
    };
    await f.controller.deleteInstance({ instanceName: 'target' });
    assert.deepEqual(f.log, ['logout', 'instance.delete', 'remove.instance', 'sessions:target', 'store:target']);
    assert.equal(f.monitor.waInstances.target, undefined);
    assert.equal(f.monitor.waInstances.other, f.other);
  }
});
