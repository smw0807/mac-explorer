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

test('failed move undo retains the operation and retries with its exact original filename', async () => {
  const calls = [];
  const history = loadHistory({
    move: async (...args) => {
      calls.push(args);
      return calls.length === 1
        ? { ok: false, items: [], error: 'original name occupied' }
        : { ok: true, items: [{ from: '/dest/original (1).txt', to: '/source/original.txt' }] };
    },
    rename: () => assert.fail('move undo must not perform a second rename'),
  });
  history.recordOp({ type: 'move', items: [{ from: '/source/original.txt', to: '/dest/original (1).txt' }] });
  await history.undoLast();
  assert.match(history.alerts[0], /original name occupied/);
  assert.deepEqual(history.changes, []);
  await history.undoLast();
  assert.deepEqual(calls, [
    [['/dest/original (1).txt'], '/source', { name: 'original.txt' }],
    [['/dest/original (1).txt'], '/source', { name: 'original.txt' }],
  ]);
  assert.deepEqual(history.changes, [['/source', '/dest']]);
  assert.equal(await history.undoLast(), null);
});

test('move undo runs in reverse order and retries only unfinished items after partial failure', async () => {
  const calls = [];
  let failOnce = true;
  const history = loadHistory({
    move: async ([from], directory, options) => {
      calls.push(from);
      if (from === '/dest/b' && failOnce) { failOnce = false; return { ok: false, items: [], error: 'blocked b' }; }
      return { ok: true, items: [{ from, to: `${directory}/${options.name}` }] };
    },
  });
  const items = ['a', 'b', 'c'].map((name) => ({ from: `/source/${name}`, to: `/dest/${name}` }));
  history.recordOp({ type: 'move', items });
  await history.undoLast();
  await history.undoLast();
  assert.deepEqual(calls, ['/dest/c', '/dest/b', '/dest/b', '/dest/a']);
  assert.equal(items.length, 3, 'undo does not mutate the caller-owned result');
  assert.equal(await history.undoLast(), null);
});

test('copy undo trashes one item at a time and retains only unfinished deletions', async () => {
  const calls = [];
  let failOnce = true;
  const history = loadHistory({
    trash: async (paths) => {
      calls.push(paths);
      if (paths[0] === '/dest/b' && failOnce) { failOnce = false; return { ok: false, trashed: [], error: 'blocked b' }; }
      return { ok: true, trashed: paths };
    },
  });
  history.recordOp({ type: 'copy', created: ['/dest/a', '/dest/b', '/dest/c'] });
  await history.undoLast();
  await history.undoLast();
  assert.deepEqual(calls, [['/dest/c'], ['/dest/b'], ['/dest/b'], ['/dest/a']]);
  assert.equal(await history.undoLast(), null);
});

test('create undo survives an IPC rejection and can be retried', async () => {
  let calls = 0;
  const history = loadHistory({
    trash: async (paths) => {
      if (++calls === 1) throw new Error('IPC disconnected');
      return { ok: true, trashed: paths };
    },
  });
  history.recordOp({ type: 'create', path: '/dest/new-folder' });
  await history.undoLast();
  await history.undoLast();
  assert.equal(calls, 2);
  assert.match(history.alerts[0], /IPC disconnected/);
  assert.equal(await history.undoLast(), null);
});

test('rename batch undo keeps its failed item after reversing later items', async () => {
  const calls = [];
  let failOnce = true;
  const history = loadHistory({
    rename: async (from, name) => {
      calls.push([from, name]);
      if (from === '/test/new-a' && failOnce) { failOnce = false; return { ok: false, error: 'occupied' }; }
      return { ok: true, path: `/test/${name}` };
    },
  });
  history.recordOp({ type: 'renameBatch', items: [
    { from: '/test/a', to: '/test/new-a' }, { from: '/test/b', to: '/test/new-b' },
  ] });
  await history.undoLast();
  await history.undoLast();
  assert.deepEqual(calls, [['/test/new-b', 'b'], ['/test/new-a', 'a'], ['/test/new-a', 'a']]);
  assert.equal(await history.undoLast(), null);
});

test('concurrent undo is ignored and a new operation recorded during undo is preserved', async () => {
  const pending = deferred();
  const calls = [];
  const history = loadHistory({
    trash: (paths) => { calls.push(paths); return calls.length === 1 ? pending.promise : Promise.resolve({ ok: true, trashed: paths }); },
  });
  history.recordOp({ type: 'copy', created: ['/test/old'] });
  const firstUndo = history.undoLast();
  assert.equal(await history.undoLast(), null);
  history.recordOp({ type: 'create', path: '/test/new' });
  pending.resolve({ ok: true, trashed: ['/test/old'] });
  await firstUndo;
  await history.undoLast();
  assert.deepEqual(calls, [['/test/old'], ['/test/new']]);
  assert.equal(await history.undoLast(), null);
});

test('a failed in-flight undo remains below newer records without losing either operation', async () => {
  const pending = deferred();
  const calls = [];
  const history = loadHistory({
    trash: (paths) => { calls.push(paths); return calls.length === 1 ? pending.promise : Promise.resolve({ ok: true, trashed: paths }); },
  });
  history.recordOp({ type: 'create', path: '/test/old' });
  const firstUndo = history.undoLast();
  history.recordOp({ type: 'create', path: '/test/new' });
  pending.resolve({ ok: false, trashed: [], error: 'old still blocked' });
  await firstUndo;
  await history.undoLast();
  await history.undoLast();
  assert.deepEqual(calls, [['/test/old'], ['/test/new'], ['/test/old']]);
});

test('move undo never trashes a fully copied recovery destination after source cleanup fails', async () => {
  let calls = 0;
  const history = loadHistory({
    move: async () => { calls += 1; return { ok: false, items: [], recovery: [{ from: '/dest/a', to: '/source/a' }], error: 'preserved /source/a; cleanup failed' }; },
    trash: () => assert.fail('recovery copies must not be deleted'),
  });
  history.recordOp({ type: 'move', items: [{ from: '/source/a', to: '/dest/a' }] });
  await history.undoLast();
  await history.undoLast();
  assert.equal(calls, 2);
  assert.match(history.alerts[0], /preserved \/source\/a/);
  assert.deepEqual(history.changes[0], ['/dest', '/source']);
});

test('drag-and-drop copy records completed items even when another source fails', async () => {
  const trashed = [];
  const history = loadHistory({
    conflicts: async () => ({ ok: true, names: [] }),
    copy: async () => ({ ok: false, created: ['/dest/a'], error: 'b failed' }),
    trash: async (paths) => { trashed.push(paths); return { ok: true, trashed: paths }; },
  });
  await history.dropToDir(dropEvent(['/source/a', '/source/b'], true), '/dest');
  assert.match(history.alerts[0], /b failed/);
  assert.deepEqual(history.changes[0], ['/dest', '/source']);
  await history.undoLast();
  assert.deepEqual(trashed, [['/dest/a']]);
});

test('drag-and-drop move records successful items but excludes recovery copies from undo', async () => {
  const restored = [];
  const history = loadHistory({
    conflicts: async () => ({ ok: true, names: [] }),
    move: async ([from], directory, options) => {
      if (options.name) {
        restored.push(from);
        return { ok: true, items: [{ from, to: `${directory}/${options.name}` }] };
      }
      return { ok: false, items: [{ from: '/source/a', to: '/dest/a' }], recovery: [{ from: '/source/b', to: '/dest/b' }], error: 'b recovery preserved' };
    },
  });
  await history.dropToDir(dropEvent(['/source/a', '/source/b']), '/dest');
  await history.undoLast();
  assert.deepEqual(restored, ['/dest/a']);
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
