const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');

function loadHistory(api = {}) {
  const result = buildSync({
    stdin: {
      contents: "export * from './src/undo.js'; export * from './src/dnd.js';",
      resolveDir: path.resolve(__dirname, '..'),
      sourcefile: 'undo-test-entry.js',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  });
  const alerts = [];
  const changes = [];
  const window = {
    api,
    dispatchEvent: (event) => changes.push(event.detail.dirs),
  };
  const module = { exports: {} };
  const CustomEvent = class {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  };
  new Function('module', 'exports', 'window', 'CustomEvent', 'alert', result.outputFiles[0].text)(
    module, module.exports, window, CustomEvent, (message) => alerts.push(message),
  );
  return { ...module.exports, alerts, changes };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function dropEvent(paths, copy = false) {
  return { altKey: copy, dataTransfer: { getData: () => JSON.stringify(paths) } };
}

const undoEntry = (token, path = `/display/${token}`) => ({ path, token });

test('undo delegates only the opaque token and trusts backend success for aliased paths', async () => {
  const calls = [];
  const history = loadHistory({
    undo: async (token) => {
      calls.push(token);
      return calls.length === 1
        ? { ok: false, dirs: [], error: 'original name occupied' }
        : { ok: true, dirs: ['/actual/source', '/actual/dest'] };
    },
    move: () => assert.fail('undo must not reconstruct a move from paths'),
    rename: () => assert.fail('undo must not reconstruct a rename from paths'),
    trash: () => assert.fail('undo must not reconstruct a deletion from paths'),
  });
  history.recordOp({ type: 'move', undo: [undoEntry('opaque-move', '/alias/dest')] });
  await history.undoLast();
  assert.match(history.alerts[0], /original name occupied/);
  assert.deepEqual(history.changes, []);
  await history.undoLast();
  assert.deepEqual(calls, ['opaque-move', 'opaque-move']);
  assert.deepEqual(history.changes, [['/actual/source', '/actual/dest']]);
  assert.equal(await history.undoLast(), null);
});

test('multi-item undo runs in reverse order and retries only unfinished tokens after partial failure', async () => {
  const calls = [];
  let failOnce = true;
  const history = loadHistory({
    undo: async (token) => {
      calls.push(token);
      if (token === 'b' && failOnce) { failOnce = false; return { ok: false, dirs: [], error: 'blocked b' }; }
      return { ok: true, dirs: ['/dest'] };
    },
  });
  const undo = ['a', 'b', 'c'].map((token) => undoEntry(token));
  history.recordOp({ type: 'copy', undo });
  await history.undoLast();
  await history.undoLast();
  assert.deepEqual(calls, ['c', 'b', 'b', 'a']);
  assert.equal(undo.length, 3, 'undo does not mutate the caller-owned result');
  assert.equal(await history.undoLast(), null);
});

test('create undo survives an IPC rejection and can be retried', async () => {
  let calls = 0;
  const history = loadHistory({
    undo: async () => {
      if (++calls === 1) throw new Error('IPC disconnected');
      return { ok: true, dirs: ['/dest'] };
    },
  });
  history.recordOp({ type: 'create', undo: [undoEntry('new-folder')] });
  await history.undoLast();
  await history.undoLast();
  assert.equal(calls, 2);
  assert.match(history.alerts[0], /IPC disconnected/);
  assert.equal(await history.undoLast(), null);
});

test('rename batch undo retains a failed token and reports every affected recovery directory', async () => {
  const calls = [];
  let failOnce = true;
  const history = loadHistory({
    undo: async (token) => {
      calls.push(token);
      if (token === 'a' && failOnce) {
        failOnce = false;
        return { ok: false, dirs: ['/recovery', '/test'], error: 'recovery preserved' };
      }
      return { ok: true, dirs: ['/test'] };
    },
  });
  history.recordOp({ type: 'renameBatch', undo: [undoEntry('a'), undoEntry('b')] });
  await history.undoLast();
  assert.deepEqual(history.changes, [['/test', '/recovery']]);
  await history.undoLast();
  assert.deepEqual(calls, ['b', 'a', 'a']);
  assert.equal(await history.undoLast(), null);
});

test('concurrent undo is ignored and a new operation recorded during undo is preserved', async () => {
  const pending = deferred();
  const calls = [];
  const history = loadHistory({
    undo: (token) => { calls.push(token); return calls.length === 1 ? pending.promise : Promise.resolve({ ok: true, dirs: ['/test'] }); },
  });
  history.recordOp({ type: 'copy', undo: [undoEntry('old')] });
  const firstUndo = history.undoLast();
  assert.equal(await history.undoLast(), null);
  history.recordOp({ type: 'create', undo: [undoEntry('new')] });
  pending.resolve({ ok: true, dirs: ['/test'] });
  await firstUndo;
  await history.undoLast();
  assert.deepEqual(calls, ['old', 'new']);
  assert.equal(await history.undoLast(), null);
});

test('a failed in-flight undo remains below newer records without losing either operation', async () => {
  const pending = deferred();
  const calls = [];
  const history = loadHistory({
    undo: (token) => { calls.push(token); return calls.length === 1 ? pending.promise : Promise.resolve({ ok: true, dirs: [] }); },
  });
  history.recordOp({ type: 'create', undo: [undoEntry('old')] });
  const firstUndo = history.undoLast();
  history.recordOp({ type: 'create', undo: [undoEntry('new')] });
  pending.resolve({ ok: false, dirs: [], error: 'old still blocked' });
  await firstUndo;
  await history.undoLast();
  await history.undoLast();
  assert.deepEqual(calls, ['old', 'new', 'old']);
});

test('operations without valid backend tokens never fall back to path-based undo', async () => {
  const history = loadHistory({
    undo: () => assert.fail('no valid token was supplied'),
    move: () => assert.fail('unsafe path fallback'),
    rename: () => assert.fail('unsafe path fallback'),
    trash: () => assert.fail('unsafe path fallback'),
  });
  history.recordOp({ type: 'copy', created: ['/test/copied'] });
  history.recordOp({ type: 'move', items: [{ from: '/source/a', to: '/dest/a' }] });
  history.recordOp({ type: 'rename', from: '/source/a', to: '/source/b' });
  history.recordOp({ type: 'create', path: '/test/new', undo: [null, {}, { token: '' }, { token: 42 }] });
  assert.equal(await history.undoLast(), null);
  assert.deepEqual(history.alerts, []);
});

test('history retains 50 operations and releases only the evicted operation tokens', async () => {
  const released = [];
  const undone = [];
  const history = loadHistory({
    undoRelease: async (tokens) => { released.push(tokens); return { ok: true }; },
    undo: async (token) => { undone.push(token); return { ok: true, dirs: [] }; },
  });
  for (let i = 0; i < 51; i++) history.recordOp({ type: 'create', undo: [undoEntry(`token-${i}`)] });
  assert.deepEqual(released, [['token-0']]);
  for (let i = 0; i < 50; i++) await history.undoLast();
  assert.equal(undone.length, 50);
  assert.equal(undone[0], 'token-50');
  assert.equal(undone.at(-1), 'token-1');
  assert.equal(await history.undoLast(), null);
});

test('history eviction protects in-flight undo and tolerates a failed token release', async () => {
  const pending = deferred();
  const released = [];
  const calls = [];
  const history = loadHistory({
    undo: (token) => { calls.push(token); return calls.length === 1 ? pending.promise : Promise.resolve({ ok: true, dirs: [] }); },
    undoRelease: async (tokens) => { released.push(tokens); throw new Error('renderer disconnecting'); },
  });
  history.recordOp({ type: 'create', undo: [undoEntry('active')] });
  const active = history.undoLast();
  for (let i = 0; i < 50; i++) history.recordOp({ type: 'create', undo: [undoEntry(`new-${i}`)] });
  assert.deepEqual(released, [['new-0']]);
  pending.resolve({ ok: true, dirs: [] });
  await active;
  for (let i = 0; i < 49; i++) await history.undoLast();
  assert.deepEqual(calls, ['active', ...Array.from({ length: 49 }, (_, i) => `new-${49 - i}`)]);
  assert.equal(await history.undoLast(), null);
});

test('drag-and-drop copy records backend tokens even when another source fails', async () => {
  const undone = [];
  const history = loadHistory({
    conflicts: async () => ({ ok: true, names: [] }),
    copy: async () => ({ ok: false, created: ['/dest/a'], undo: [undoEntry('copied-a', '/dest/a')], error: 'b failed' }),
    undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/dest'] }; },
  });
  await history.dropToDir(dropEvent(['/source/a', '/source/b'], true), '/dest');
  assert.match(history.alerts[0], /b failed/);
  assert.deepEqual(history.changes[0], ['/dest', '/source']);
  await history.undoLast();
  assert.deepEqual(undone, ['copied-a']);
});

test('drag-and-drop move records only backend-issued tokens and never reconstructs recovery undo', async () => {
  const undone = [];
  const history = loadHistory({
    conflicts: async () => ({ ok: true, names: [] }),
    move: async () => ({
      ok: false, items: [{ from: '/source/a', to: '/dest/a' }],
      recovery: [{ from: '/source/b', to: '/dest/b' }],
      undo: [undoEntry('moved-a', '/dest/a')], error: 'b recovery preserved',
    }),
    undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/source', '/dest'] }; },
  });
  await history.dropToDir(dropEvent(['/source/a', '/source/b']), '/dest');
  await history.undoLast();
  assert.deepEqual(undone, ['moved-a']);
  assert.equal(await history.undoLast(), null);
});

test('internal drag payloads reject malformed and non-absolute paths before any file operation', async () => {
  const history = loadHistory({ conflicts: () => assert.fail('invalid payloads must not reach the filesystem API') });
  const malformed = [
    '{', 'null', 'false', '17', '{}', '"/test/file"',
    '["/test/valid", null]', '["/test/valid", 42]', '["/test/valid", {}]',
    '["relative/file"]', '[""]', '["/test/bad\\u0000name"]',
  ];
  for (const raw of malformed) {
    const event = { altKey: false, dataTransfer: { getData: () => raw } };
    assert.deepEqual(history.extractDropPaths(event), [], raw);
    await history.dropToDir(event, '/destination');
  }
});

test('internal drag payloads preserve valid absolute filenames including spaces and newlines', () => {
  const history = loadHistory();
  const paths = ['/test/space name', '/test/line\nbreak', '/test/-dash', '/test/한글'];
  assert.deepEqual(history.extractDropPaths(dropEvent(paths)), paths);
  assert.deepEqual(history.extractDropPaths(dropEvent([])), []);
});

test('a completed undo reports cleanup warnings without retaining a consumed token', async () => {
  const history = loadHistory({
    undo: async () => ({ ok: true, dirs: ['/restored'], warning: '남은 임시 폴더: /recovery' }),
  });
  history.recordOp({ type: 'move', undo: [undoEntry('completed-with-warning')] });
  assert.equal(await history.undoLast(), 'move');
  assert.deepEqual(history.alerts, ['남은 임시 폴더: /recovery']);
  assert.deepEqual(history.changes, [['/restored']]);
  assert.equal(await history.undoLast(), null);
});
