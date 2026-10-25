const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const operations = require('../electron/file-operations.cjs');
const { loadMain } = require('./helpers/main.cjs');

for (const canceled of [false, true]) {
  test(`copy terminal event retains completed items after ${canceled ? 'cancel' : 'error'}`, async (t) => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-ipc-')));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const destDir = path.join(root, 'dest');
    await fsp.mkdir(destDir);
    const inputs = ['first', 'second'].map((name) => path.join(root, name));
    for (const input of inputs) await fsp.writeFile(input, 'contents');
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const api = loadMain({
      onSend: (_channel, data) => { if (data.done) finish(data); },
      overrides: { './file-operations.cjs': {
        ...operations,
        async copyItem(src, dir, opts) {
          if (src === inputs[1]) throw new Error('injected failure');
          const result = await operations.copyItem(src, dir, opts);
          if (canceled) { opts.job.canceled = true; opts.job.controller.abort(); }
          return result;
        },
      } },
    });
    const start = api.invoke('fs:copyStart', inputs, destDir);
    const terminal = await done;
    assert.equal(terminal.jobId, start.jobId);
    assert.equal(terminal.destDir, destDir);
    assert.deepEqual(terminal.created, [path.join(destDir, 'first')]);
    assert.equal(!!terminal.canceled, canceled);
    assert.equal(await fsp.readFile(path.join(destDir, 'first'), 'utf8'), 'contents');
  });
}

test('recursive search respects hidden files and reports depth and result limits', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-search-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, '.config'));
  await fsp.writeFile(path.join(root, '.env'), 'private');
  await fsp.writeFile(path.join(root, '.config', 'settings.txt'), 'private');
  await fsp.writeFile(path.join(root, 'visible.txt'), 'public');
  const api = loadMain();
  assert.deepEqual((await api.invoke('fs:search', root, 'env')).entries, []);
  assert.equal((await api.invoke('fs:search', root, 'env', { showHidden: true })).entries[0].name, '.env');
  const nested = await api.invoke('fs:search', root, 'settings', { showHidden: true });
  assert.equal(nested.entries[0].name, 'settings.txt');
  assert.equal(nested.entries[0].hidden, true);
  assert.equal(nested.truncated, false);
  const shallow = await api.invoke('fs:search', root, 'settings', { showHidden: true, maxDepth: 0 });
  assert.equal(shallow.entries.length, 0);
  assert.equal(shallow.truncated, true);
  const limited = await api.invoke('fs:search', root, '', { showHidden: true, maxResults: 1 });
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal((await api.invoke('fs:search', path.join(root, 'missing'), 'x')).ok, false);
});

test('Spotlight handles newline filenames and filters hidden ancestors', async () => {
  let args;
  const api = loadMain({ overrides: {
    child_process: { execFile: (_command, input, _options, callback) => {
      args = input;
      callback(null, { stdout: '/search/.config/settings.txt\0/search/line\nbreak.txt\0' });
    } },
    'fs/promises': { ...fsp,
      lstat: async () => ({ isDirectory: () => false, isSymbolicLink: () => false, size: 1, mtimeMs: 0 }),
    },
  } });
  const result = await api.invoke('fs:searchSpotlight', '/search', 'txt');
  assert.equal(result.ok, true);
  assert.equal(args[0], '-0');
  assert.deepEqual(result.entries.map((entry) => entry.path), ['/search/line\nbreak.txt']);
  const withHidden = await api.invoke('fs:searchSpotlight', '/search', 'txt', { showHidden: true });
  assert.equal(withHidden.entries.length, 2);
  assert.equal(withHidden.entries[0].hidden, true);
});

test('text preview closes its descriptor even when reading fails', async () => {
  let closed = 0;
  const api = loadMain({ overrides: { 'fs/promises': {
    ...fsp,
    open: async () => ({
      read: async () => { throw new Error('read failed'); },
      close: async () => { closed++; },
    }),
  } } });
  const result = await api.invoke('fs:readText', '/preview.txt');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'read failed');
  assert.equal(closed, 1);
});

for (const mode of ['copy', 'move']) {
  test(`${mode} returns completed items when a later input fails`, async () => {
    const operation = mode === 'copy' ? 'copyItem' : 'moveItem';
    const api = loadMain({ overrides: { './file-operations.cjs': {
      ...operations,
      validateBatch: async () => {},
      [operation]: async (src) => {
        if (src === '/source/second') throw new Error('second failed');
        return '/dest/first';
      },
    } } });
    const result = await api.invoke(`fs:${mode}`, ['/source/first', '/source/second'], '/dest');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'second failed');
    assert.deepEqual(mode === 'copy' ? result.created : result.items,
      mode === 'copy' ? ['/dest/first'] : [{ from: '/source/first', to: '/dest/first' }]);
  });
}

test('an EXDEV cleanup failure reports a recovery copy separately from completed moves', async () => {
  const api = loadMain({ overrides: { './file-operations.cjs': {
    ...operations,
    validateBatch: async () => {},
    moveItem: async () => { throw Object.assign(new Error('source cleanup failed'), { committedDest: '/dest/file' }); },
  } } });
  const result = await api.invoke('fs:move', ['/source/file'], '/dest');
  assert.equal(result.ok, false);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.recovery, [{ from: '/source/file', to: '/dest/file' }]);
});

test('trash reports the exact successful subset on failure', async () => {
  const api = loadMain({ shell: { trashItem: async (p) => { if (p === '/second') throw new Error('trash failed'); } } });
  const result = await api.invoke('fs:trash', ['/first', '/second']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.trashed, ['/first']);
});

for (const progress of [false, true]) {
  test(`copy ${progress ? 'progress' : 'response'} reports a committed destination when backup cleanup fails`, async () => {
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const api = loadMain({
      onSend: (_channel, event) => { if (event.done) finish(event); },
      overrides: { './file-operations.cjs': {
        ...operations,
        validateBatch: async () => {},
        treeSize: async () => 1,
        copyItem: async () => { throw Object.assign(new Error('changed backup preserved'), { committedDest: '/dest/file' }); },
      } },
    });
    const response = api.invoke(progress ? 'fs:copyStart' : 'fs:copy', ['/source/file'], '/dest');
    const result = await (progress ? done : response);
    assert.deepEqual(result.created, ['/dest/file']);
    assert.match(result.error, /changed backup preserved/);
  });
}
