const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { loadMain } = require('./helpers/main.cjs');
const fileOperations = require('../electron/file-operations.cjs');
const { createOperationLifecycle } = require('../electron/operation-lifecycle.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const mutations = [
  ['fs:copy', [['/source'], '/destination']],
  ['fs:move', [['/source'], '/destination']],
  ['fs:trash', [['/source']]],
  ['fs:rename', ['/source', 'renamed']],
  ['fs:mkdir', ['/parent', 'new-directory']],
  ['fs:newFile', ['/parent', 'new-file']],
  ['fs:compress', [['/source']]],
  ['fs:extract', ['/source.zip']],
  ['fs:undo', ['owned-token']],
];

for (const [channel, args] of mutations) {
  test(`normal quit waits for ${channel} and rejects new mutations while draining`, async () => {
    const started = deferred();
    const release = deferred();
    let calls = 0;
    const operation = async () => {
      calls++;
      started.resolve();
      await release.promise;
      return '/destination/result';
    };
    const api = loadMain({ shell: { trashItem: operation }, overrides: {
      './file-operations.cjs': {
        ...fileOperations,
        validateBatch: async () => {},
        uniqueDest: async (dir, name) => path.join(dir, name),
        copyItem: operation,
        moveItem: operation,
        createItem: operation,
      },
      './undo-registry.cjs': { createUndoRegistry: () => ({
        recordCreate: () => null, recordMove: () => null, restored() {}, release() {},
        undo: async () => { await operation(); return { ok: true, dirs: [] }; },
      }) },
      './archive.cjs': { compress: operation, extract: operation },
      'fs/promises': { ...fsp, mkdir: operation, writeFile: operation },
      child_process: { execFile: (_command, _args, callback) => { operation().then(() => callback(null, '')); } },
    } });
    const result = api.invoke(channel, ...args);
    await started.promise;
    const app = api.electron.app;
    assert.equal(app.quit().defaultPrevented, true);
    assert.equal(app.quit().defaultPrevented, true);
    await tick();
    assert.equal(app.completedQuits, 0);
    for (const [nextChannel, nextArgs] of mutations) {
      const rejected = await api.invoke(nextChannel, ...nextArgs);
      assert.equal(rejected.ok, false, nextChannel);
      assert.match(rejected.error, /종료하는 중/, nextChannel);
    }
    assert.match(api.invoke('fs:copyStart', ['/source'], '/destination').error, /종료하는 중/);
    assert.equal(calls, 1);
    release.resolve();
    assert.equal((await result).ok, true);
    await tick();
    assert.equal(app.completedQuits, 1);
    assert.equal(app.quitAttempts, 3, 'the final quit bypasses the guard exactly once');
  });
}

test('quit waits for every concurrent mutation, including failure rollback and cleanup', async () => {
  const started = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  const cleanupStarted = deferred();
  const cleanupFinished = deferred();
  const api = loadMain({ overrides: { './file-operations.cjs': {
    ...fileOperations,
    validateBatch: async () => {},
    moveItem: async (source) => {
      const index = source === '/first' ? 0 : 1;
      started[index].resolve();
      try {
        await release[index].promise;
        if (index === 1) throw new Error('move failed');
        return '/destination/first';
      } finally {
        if (index === 1) {
          cleanupStarted.resolve();
          await cleanupFinished.promise;
        }
      }
    },
  } } });
  const first = api.invoke('fs:move', ['/first'], '/destination');
  const second = api.invoke('fs:move', ['/second'], '/destination');
  await Promise.all(started.map(({ promise }) => promise));
  api.electron.app.quit();
  release[0].resolve();
  assert.equal((await first).ok, true);
  await tick();
  assert.equal(api.electron.app.completedQuits, 0);
  release[1].resolve();
  await cleanupStarted.promise;
  await tick();
  assert.equal(api.electron.app.completedQuits, 0, 'rollback/cleanup still owns the operation');
  cleanupFinished.resolve();
  assert.equal((await second).error, 'move failed');
  await tick();
  assert.equal(api.electron.app.completedQuits, 1);
});

test('quit aborts detached copyStart jobs but waits for their asynchronous cleanup', async () => {
  const started = deferred();
  const cleanupStarted = deferred();
  const cleanupFinished = deferred();
  const terminal = deferred();
  let job;
  const api = loadMain({ onSend: (_channel, data) => { if (data.done) terminal.resolve(data); }, overrides: {
    './file-operations.cjs': {
      ...fileOperations,
      validateBatch: async () => {},
      treeSize: async () => 1,
      copyItem: async (_source, _dest, options) => {
        job = options.job;
        const canceled = new Promise((resolve) => job.controller.signal.addEventListener('abort', resolve, { once: true }));
        started.resolve();
        try {
          await canceled;
          throw fileOperations.cancelError();
        } finally {
          cleanupStarted.resolve();
          await cleanupFinished.promise;
        }
      },
    },
  } });
  const response = api.invoke('fs:copyStart', ['/source'], '/destination');
  assert.equal(response.ok, true);
  assert.equal(typeof response.jobId, 'number');
  assert.equal(response.then, undefined);
  await started.promise;
  api.electron.app.quit();
  assert.equal(job.canceled, true);
  assert.equal(job.controller.signal.aborted, true);
  await cleanupStarted.promise;
  await tick();
  assert.equal(api.electron.app.completedQuits, 0);
  cleanupFinished.resolve();
  assert.equal((await terminal.promise).canceled, true);
  await tick();
  assert.equal(api.electron.app.completedQuits, 1);
  assert.equal(api.event.sender.listenerCount('destroyed'), 0);
});

test('settings remain writable during shutdown preparation without admitting new file operations', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-quit-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const started = deferred();
  const release = deferred();
  const api = loadMain({ userData: root, shell: { trashItem: async () => {
    started.resolve();
    await release.promise;
  } } });
  const result = api.invoke('fs:trash', ['/source']);
  await started.promise;
  api.electron.app.quit();
  assert.equal(api.invoke('settings:set', { favorites: [] }).ok, true);
  assert.deepEqual(api.invoke('settings:get').settings, { favorites: [] });
  release.resolve();
  await result;
  await tick();
  assert.equal(api.electron.app.completedQuits, 1);
});

test('quit with no pending work exits once without reopening a window on activation', async () => {
  const api = loadMain();
  api.ready();
  api.windows.length = 0;
  api.electron.app.quit();
  api.electron.app.emit('activate');
  await tick();
  assert.equal(api.windows.length, 0);
  assert.equal(api.electron.app.completedQuits, 1);
  assert.equal(api.electron.app.quitAttempts, 2);
});

test('an asynchronous shutdown preparation can finish or fail without leaving operations locked', async () => {
  const app = new EventEmitter();
  let quits = 0;
  app.quit = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    app.emit('before-quit', event);
    if (!event.prevented) quits++;
  };
  const prepare = deferred();
  let fail = true;
  let canceled = 0;
  const errors = [];
  const lifecycle = createOperationLifecycle(app, {
    cancelOperations: () => { canceled++; },
    prepareToQuit: async () => {
      await prepare.promise;
      if (fail) throw new Error('settings flush failed');
    },
    onError: (error) => errors.push(error.message),
  });
  app.quit();
  app.quit();
  assert.equal(canceled, 1);
  assert.equal(lifecycle.isShuttingDown(), true);
  assert.throws(() => lifecycle.run(() => {}), /종료하는 중/);
  prepare.resolve();
  await tick();
  assert.deepEqual(errors, ['settings flush failed']);
  assert.equal(quits, 0);
  assert.equal(lifecycle.run(() => 'still usable'), 'still usable');
  fail = false;
  app.quit();
  await tick();
  assert.equal(quits, 1);
  assert.equal(canceled, 2);
});
