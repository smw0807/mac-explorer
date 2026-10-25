const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { loadMain } = require('./helpers/main.cjs');
const { writeSettings } = require('../electron/settings.cjs');
const operations = require('../electron/file-operations.cjs');

async function temporaryDirectory(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-security-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

test('every IPC endpoint rejects untrusted URLs and subframes before evaluating arguments', async () => {
  for (const development of [false, true]) {
    const api = loadMain({ development, userData: path.join(os.tmpdir(), 'mac-explorer-no-saved-settings') });
    const trusted = api.event.senderFrame.url;
    for (const url of ['https://example.test/', 'file:///tmp/untrusted.html', trusted + '#other', trusted + '?other']) {
      api.event.senderFrame.url = url;
      for (const channel of api.handlers.keys()) {
        const result = await api.invoke(channel);
        assert.equal(result.ok, false, channel);
        assert.match(result.error, /신뢰할 수 없는/, channel);
      }
    }
    api.event.senderFrame = { url: trusted };
    api.event.sender.mainFrame.url = trusted;
    assert.match(api.invoke('settings:get').error, /신뢰할 수 없는/);
    api.event.senderFrame = null;
    assert.match(api.invoke('settings:get').error, /신뢰할 수 없는/);
    api.event.senderFrame = api.event.sender.mainFrame;
    assert.equal(api.invoke('settings:get').ok, true);
  }
});

test('malformed IPC inputs are rejected before touching files or starting a copy', async () => {
  let calls = 0;
  const api = loadMain({ overrides: {
    './file-operations.cjs': { ...operations, validateBatch: async () => { calls++; } },
    'fs/promises': { ...fsp, open: async () => { calls++; }, readdir: async () => { calls++; } },
  } });
  const invalid = [
    ['fs:readDir', 'relative'], ['fs:readDir', '/tmp/with\0nul'],
    ['fs:copy', [], '/dest'], ['fs:copy', ['/source', 3], '/dest'],
    ['fs:copy', ['/source'], '/dest', { conflict: 'delete' }],
    ['fs:copy', ['/source'], '/dest', { name: 'new' }],
    ['fs:move', ['/one', '/two'], '/dest', { name: 'new' }],
    ['fs:move', ['/source'], '/dest', { name: '../new' }],
    ['fs:move', ['/source'], '/dest', Object.create({ conflict: 'overwrite' })],
    ['fs:rename', '/source', '..'], ['fs:newFile', '/parent', 'sub/file'],
    ['fs:mkdir', '/parent', ''], ['fs:openWithApp', '/source', '-a'],
    ['fs:readText', '/source', 0], ['fs:readText', '/source', 1024 * 1024 + 1],
    ['fs:readText', '/source', NaN], ['fs:readText', '/source', 1.5],
    ['fs:search', '/', null], ['fs:search', '/', 'q', { maxDepth: -1 }],
    ['fs:search', '/', 'q', { maxResults: Infinity }],
    ['fs:searchSpotlight', '/', 'q', { showHidden: 'yes' }],
    ['fs:searchSpotlight', '/', 'q', { maxDepth: 2 }],
    ['fs:copyCancel', '1'], ['fs:watch', '', '/'], ['clipboard:writeText', {}],
    ['settings:set', { extra: true }], ['settings:get', 'extra'],
  ];
  for (const field of ['protectedDestinations', 'job', 'report']) {
    for (const channel of ['fs:copy', 'fs:copyStart', 'fs:move']) {
      invalid.push([channel, ['/source'], '/dest', { [field]: {} }]);
    }
  }
  for (const [channel, ...args] of invalid) {
    const result = await api.invoke(channel, ...args);
    assert.equal(result.ok, false, channel + ' ' + JSON.stringify(args));
  }
  assert.equal(calls, 0);
});

test('absolute roots and volume paths remain accessible, and preview reads accept the bounded maximum', async () => {
  const visited = [];
  let allocated;
  const api = loadMain({ overrides: { 'fs/promises': {
    ...fsp,
    readdir: async (p) => { visited.push(p); return []; },
    open: async () => ({
      read: async (buffer) => { allocated = buffer.length; return { bytesRead: 0 }; },
      close: async () => {},
    }),
  } } });
  for (const p of ['/', '/Volumes/외장 디스크', '/tmp/link/../folder']) {
    assert.equal((await api.invoke('fs:readDir', p)).ok, true);
  }
  assert.deepEqual(visited, ['/', '/Volumes/외장 디스크', '/tmp/link/../folder']);
  assert.equal((await api.invoke('fs:readText', '/preview.txt', 1024 * 1024)).ok, true);
  assert.equal(allocated, 1024 * 1024);
});

test('a validated single-source move retains its exact name and internal protected destinations', async () => {
  let received;
  const api = loadMain({ overrides: { './file-operations.cjs': {
    ...operations, validateBatch: async () => {},
    moveItem: async (src, dir, opts) => { received = opts; return path.join(dir, opts.name); },
  } } });
  const name = ' 원래\\이름\n.txt';
  const result = await api.invoke('fs:move', ['/source/current'], '/dest', { name });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, [{ from: '/source/current', to: path.join('/dest', name) }]);
  assert.deepEqual(received, { name, protectedDestinations: ['/source/current'] });
});

test('copyStart stays synchronous and another trusted window cannot cancel its job', async () => {
  let release;
  let finish;
  const gate = new Promise((resolve) => { release = resolve; });
  const done = new Promise((resolve) => { finish = resolve; });
  let job;
  const api = loadMain({ onSend: (_channel, data) => { if (data.done) finish(data); }, overrides: {
    './file-operations.cjs': { ...operations,
      validateBatch: async () => {},
      treeSize: async (_p, value) => { job = value; await gate; return 0; },
      copyItem: async () => '/dest/file',
    },
  } });
  const start = api.invoke('fs:copyStart', ['/source/file'], '/dest');
  assert.equal(start.ok, true);
  assert.equal(typeof start.jobId, 'number');
  assert.equal(start.then, undefined);
  await Promise.resolve();
  const other = { ...api.event, sender: { ...api.event.sender, id: 2 } };
  assert.equal(api.handlers.get('fs:copyCancel')(other, start.jobId).ok, false);
  assert.equal(job.canceled, false);
  assert.equal(api.invoke('fs:copyCancel', start.jobId).ok, true);
  release();
  assert.equal((await done).canceled, true);
});

test('window security settings deny page and frame navigation and all new windows', () => {
  for (const development of [false, true]) {
    const api = loadMain({ development });
    api.ready();
    const window = api.windows[0];
    const prefs = window.options.webPreferences;
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.navigateOnDragDrop, false);
    assert.equal(prefs.webviewTag, false);
    assert.equal(window.url, api.event.senderFrame.url);
    let blocked = 0;
    for (const name of ['will-navigate', 'will-frame-navigate']) {
      window.webContents.emit(name, { preventDefault() { blocked++; } });
    }
    assert.equal(blocked, 2);
    assert.deepEqual(window.webContents.windowOpenHandler({ url: 'https://example.test/' }), { action: 'deny' });
  }
});

test('localfile rejects invalid paths and methods, keeps CSP enforcement, and forwards media ranges', async () => {
  let captured;
  const api = loadMain({ overrides: { electron: { net: {
    fetch: async (url, options) => { captured = { url, options }; return new Response('preview'); },
  } } } });
  api.ready();
  assert.equal(api.schemes[0].privileges.bypassCSP, undefined);
  const handler = api.protocols.get('localfile');
  for (const url of ['localfile://relative', 'localfile://%ZZ', 'localfile://%2Ftmp%00x', 'https://example.test/']) {
    const result = await handler(new Request(url));
    assert.equal(result.status, 400, url);
  }
  assert.equal((await handler(new Request('localfile://%2Ftmp%2Fx', { method: 'POST' }))).status, 405);
  assert.equal(captured, undefined);
  const file = '/Volumes/외장 디스크/장면 #1?.mp4';
  const result = await handler(new Request('localfile://' + encodeURIComponent(file), { headers: { Range: 'bytes=10-20', 'X-Untrusted': 'ignored' } }));
  assert.equal(result.status, 200);
  assert.equal(captured.url, pathToFileURL(file).href);
  assert.equal(captured.options.headers.get('range'), 'bytes=10-20');
  assert.equal(captured.options.headers.has('X-Untrusted'), false);
});

test('settings recover valid fields from malformed data and persist empty favorites', async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'settings.json');
  const api = loadMain({ userData: root });
  await fsp.writeFile(file, JSON.stringify({
    favorites: [null, { path: 'relative', name: 'bad' }, { path: '/Volumes/Disk', name: 'Disk' }],
    session: { tabs: [null, { paths: 'bad' }, { paths: ['/', null, '/tmp'], dual: true }], active: -10, showHidden: 'yes' },
  }));
  const restored = api.invoke('settings:get').settings;
  assert.deepEqual(restored.favorites, [{ path: '/Volumes/Disk', name: 'Disk', icon: '📁' }]);
  assert.deepEqual(restored.session, { tabs: [{ paths: ['/', '/tmp'], dual: true }], active: 0, showHidden: false });
  assert.equal(api.invoke('settings:set', { favorites: [] }).ok, true);
  assert.deepEqual(api.invoke('settings:get').settings.favorites, []);
  assert.deepEqual(api.invoke('settings:get').settings.session, restored.session);
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  const before = await fsp.readFile(file, 'utf8');
  for (const patch of [[], { favorites: [{ path: '/', name: 'root', icon: 'x', extra: true }] },
    { session: { tabs: [], active: -1, showHidden: false } }, { session: { tabs: [], active: 0, showHidden: 'yes' } }]) {
    assert.equal(api.invoke('settings:set', patch).ok, false);
    assert.equal(await fsp.readFile(file, 'utf8'), before);
  }
  await fsp.writeFile(file, '{broken json');
  assert.deepEqual(api.invoke('settings:get').settings, {});
});

test('failed settings write or replacement preserves the previous file and cleans its temporary file', async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'settings.json');
  const patch = { favorites: [{ path: '/', name: 'root', icon: '📁' }] };
  writeSettings(file, patch);
  const before = await fsp.readFile(file, 'utf8');
  for (const method of ['writeFileSync', 'renameSync']) {
    assert.throws(() => writeSettings(file, { favorites: [] }, { ...fs,
      [method]() { throw new Error('injected ' + method + ' failure'); },
    }), /injected/);
    assert.equal(await fsp.readFile(file, 'utf8'), before);
    assert.deepEqual(await fsp.readdir(root), ['settings.json']);
  }
});

test('watch errors clear the current watcher without closing its replacement or sending stale changes', async () => {
  const watchers = [];
  const events = [];
  const api = loadMain({ onSend: (channel, data) => events.push({ channel, data }), overrides: { fs: { ...fs,
    watch: (_dir, onChange) => {
      const watcher = Object.assign(new EventEmitter(), { onChange, closes: 0, close() { this.closes++; } });
      watchers.push(watcher);
      return watcher;
    },
  } } });
  assert.equal(api.invoke('fs:watch', 'pane', '/first').ok, true);
  assert.equal(api.invoke('fs:watch', 'pane', '/second').ok, true);
  watchers[0].emit('error', new Error('old watcher'));
  watchers[0].onChange();
  assert.equal(watchers[1].closes, 0);
  assert.deepEqual(events, []);
  watchers[1].onChange();
  watchers[1].emit('error', new Error('watch unavailable'));
  assert.equal(watchers[1].closes, 1);
  assert.deepEqual(events, [{ channel: 'fs:dirChanged', data: { paneId: 'pane', dir: '/second', error: 'watch unavailable' } }]);
  assert.equal(api.invoke('fs:watch', 'pane', '/third').ok, true);
  api.event.sender.emit('destroyed');
  assert.equal(watchers[2].closes, 1);
  watchers[2].emit('error', new Error('late error'));
  await new Promise((resolve) => setTimeout(resolve, 225));
  assert.equal(events.length, 1);
});

test('exists preserves dangling links and identifies directory link targets', async (t) => {
  const root = await temporaryDirectory(t);
  await fsp.symlink(path.join(root, 'missing'), path.join(root, 'broken'));
  await fsp.symlink(root, path.join(root, 'directory-link'));
  const api = loadMain();
  assert.deepEqual(await api.invoke('fs:exists', path.join(root, 'broken')), { ok: true, exists: true, isDir: false });
  assert.deepEqual(await api.invoke('fs:exists', path.join(root, 'directory-link')), { ok: true, exists: true, isDir: true });
});

test('asynchronous clipboard failures use the normal IPC error response', async () => {
  const api = loadMain({ overrides: { electron: { clipboard: { writeText: async () => { throw new Error('clipboard unavailable'); } } } } });
  assert.deepEqual(await api.invoke('clipboard:writeText', 'text'), { ok: false, error: 'clipboard unavailable' });
});

test('CSP distinguishes production scripts from development refresh and precedes injected scripts', async () => {
  const { contentSecurityPolicy } = await import('../vite.config.mjs');
  const production = contentSecurityPolicy(false);
  const development = contentSecurityPolicy(true);
  assert.match(production, /script-src 'self';/);
  assert.match(production, /connect-src 'none'/);
  assert.doesNotMatch(production, /ws:|unsafe-eval/);
  assert.match(production, /img-src 'self' data: localfile:/);
  assert.match(production, /media-src localfile:/);
  assert.match(development, /script-src 'self' 'unsafe-inline'/);
  assert.match(development, /ws:\/\/localhost:5173/);
  const { createServer } = await import('vite');
  const hmrServer = require('node:http').createServer();
  const server = await createServer({ server: { middlewareMode: true, hmr: { server: hmrServer } },
    optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const html = await server.transformIndexHtml('/', await fsp.readFile(path.resolve(__dirname, '../index.html'), 'utf8'));
    assert.match(html, /@react-refresh/);
    assert.match(html, /@vite\/client/);
    assert.ok(html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf('<script'));
  } finally { await server.close(); }
});
