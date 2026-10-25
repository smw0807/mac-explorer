const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadMain } = require('./helpers/main.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options = {}, count = 1) {
  const requests = [];
  const api = loadMain({ ...options, onSend(channel, data, win) {
    if (channel === 'settings:flush') requests.push({ ...data, win });
  } });
  for (let i = 0; i < count; i++) api.ready();
  const windows = [...api.windows];
  const ready = (win = windows[0]) => api.invokeFrom(win, 'settings:ready', true);
  const ack = (request, result = { ok: true }, win = request.win) =>
    api.invokeFrom(win, 'settings:flushResult', request.requestId, result);
  return { api, requests, windows, ready, ack };
}

test('close waits for hydration and the latest persisted settings within one five-second deadline', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-settings-close-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api, requests, windows: [win], ready, ack } = setup({ userData: root });
  assert.equal(win.close().defaultPrevented, true);
  assert.equal(win.isEnabled(), false);
  assert.equal(requests.length, 0);
  t.mock.timers.tick(4900);
  await tick();
  assert.equal(win.isDestroyed(), false);
  assert.deepEqual(ready(), { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reason, 'close');
  const patch = { favorites: [], session: { tabs: [{ dual: false, paths: ['/latest'] }], active: 0, showHidden: true } };
  assert.equal(api.invokeFrom(win, 'settings:set', patch).ok, true);
  t.mock.timers.tick(50);
  assert.equal(ack(requests[0]).accepted, true);
  await tick();
  assert.equal(win.isDestroyed(), true);
  assert.equal(win.closeAttempts, 2);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root, 'settings.json'), 'utf8')), patch);
  t.mock.timers.tick(10000);
  assert.equal(api.dialogs.length, 0, 'the successful acknowledgment cleared its deadline');
});

test('missing initial readiness times out, preserves input, and allows a later close retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api, requests, windows: [win], ready, ack } = setup();
  win.close();
  win.close();
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isEnabled(), true);
  assert.equal(api.dialogs.length, 1);
  assert.equal(requests.length, 0);
  ready();
  win.close();
  assert.equal(requests.length, 1);
  ack(requests[0]);
  await tick();
  assert.equal(win.isDestroyed(), true);
});

test('readiness does not reset the shared deadline and a late ACK cannot close the window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api, requests, windows: [win], ready, ack } = setup();
  win.close();
  t.mock.timers.tick(4500);
  ready();
  t.mock.timers.tick(500);
  await tick();
  assert.equal(win.isEnabled(), true);
  assert.equal(win.isDestroyed(), false);
  assert.equal(ack(requests[0]).accepted, false);
  win.close();
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  ack(requests[0]);
  await tick();
  assert.equal(win.isDestroyed(), false);
  ack(requests[1]);
  await tick();
  assert.equal(win.isDestroyed(), true);
  assert.equal(api.dialogs.length, 1);
});

test('a failed renderer save leaves the window open and retains its original enabled state', async () => {
  const { api, requests, windows: [win], ready, ack } = setup();
  win.setEnabled(false);
  ready();
  win.close();
  ack(requests[0], { ok: false, error: 'disk full' });
  await tick();
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isEnabled(), false);
  assert.equal(api.dialogs.length, 1);
  assert.match(api.dialogs[0].at(-1).detail, /disk full/);
  win.close();
  ack(requests[1]);
  await tick();
  assert.equal(win.isDestroyed(), true);
});

test('retrying close immediately when the error dialog opens starts a new save', async () => {
  let window;
  let notices = 0;
  const { requests, windows: [win], ready, ack } = setup({ overrides: { electron: {
    dialog: { showMessageBox: async () => {
      notices++;
      assert.equal(window.isEnabled(), true);
      window.close();
      return { response: 0 };
    } },
  } } });
  window = win;
  ready();
  win.close();
  ack(requests[0], { ok: false, error: 'save failed once' });
  await tick();
  assert.equal(notices, 1);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  ack(requests[1]);
  await tick();
  assert.equal(win.isDestroyed(), true);
  assert.equal(win.closeAttempts, 3);
});

test('readiness and ACK IPC reject invalid fields, other windows, and subframes', async () => {
  const { api, requests, windows: [first, second], ready, ack } = setup({}, 2);
  ready(first);
  ready(second);
  first.close();
  const id = requests[0].requestId;
  const invalid = [
    ['settings:ready'], ['settings:ready', 'yes'], ['settings:ready', true, 'extra'],
    ['settings:flushResult', '', { ok: true }], ['settings:flushResult', id, { ok: 1 }],
    ['settings:flushResult', id, { ok: true, extra: true }],
    ['settings:flushResult', id, { ok: false, error: 'x'.repeat(4097) }],
    ['settings:flushResult', id, { ok: false, error: 'nul\0error' }],
    ['settings:flushResult', id, Object.create({ ok: true })],
  ];
  for (const [channel, ...args] of invalid) assert.equal(api.invokeFrom(first, channel, ...args).ok, false);
  assert.equal(ack(requests[0], { ok: true }, second).accepted, false);
  const event = api.eventFor(first);
  const subframe = { ...event, senderFrame: { url: event.senderFrame.url } };
  assert.equal(api.handlers.get('settings:flushResult')(subframe, id, { ok: true }).ok, false);
  await tick();
  assert.equal(first.isDestroyed(), false);
  ack(requests[0]);
  await tick();
  assert.equal(first.isDestroyed(), true);
});

for (const change of ['navigation', 'unregister']) {
  test(`an ACK followed immediately by ${change} cannot approve closing a different document`, async () => {
    const { api, requests, windows: [win], ready, ack } = setup();
    ready();
    win.close();
    ack(requests[0]);
    if (change === 'navigation') {
      win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      win.webContents.mainFrame = { url: win.url };
    } else api.invokeFrom(win, 'settings:ready', false);
    await tick();
    assert.equal(win.isDestroyed(), false);
    assert.equal(win.isEnabled(), true);
    assert.equal(api.dialogs.length, 1);
    ready();
    win.close();
    ack(requests[1]);
    await tick();
    assert.equal(win.isDestroyed(), true);
  });
}

test('reload invalidates a pending ACK and requires the new document to become ready', async () => {
  const { api, requests, windows: [win], ready, ack } = setup();
  ready();
  win.close();
  const oldEvent = api.eventFor(win);
  win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  win.webContents.mainFrame = { url: win.url };
  await tick();
  assert.equal(api.handlers.get('settings:flushResult')(oldEvent, requests[0].requestId, { ok: true }).ok, false);
  assert.equal(ack(requests[0]).accepted, false);
  win.close();
  assert.equal(requests.length, 1);
  ready();
  assert.equal(requests.length, 2);
  ack(requests[1]);
  await tick();
  assert.equal(win.isDestroyed(), true);
});

test('initial navigation and child-frame navigation cannot discard a readiness wait', async () => {
  const { requests, windows: [win], ready, ack } = setup();
  win.close();
  win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  win.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  ready();
  win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  ack(requests[0]);
  await tick();
  assert.equal(win.isDestroyed(), true);
});

test('a renderer crash fails an in-flight save promptly without waiting for its timer', async () => {
  const { api, requests, windows: [win], ready, ack } = setup();
  ready();
  win.close();
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick();
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isEnabled(), true);
  assert.equal(api.dialogs.length, 1);
  assert.equal(ack(requests[0]).accepted, false);
});

test('quit waits for file cleanup before requesting the final renderer save', async () => {
  const started = deferred();
  const release = deferred();
  const { api, requests, windows: [win], ready, ack } = setup({ shell: { trashItem: async () => {
    started.resolve();
    await release.promise;
  } } });
  ready();
  const fileOperation = api.invokeFrom(win, 'fs:trash', ['/fixture']);
  await started.promise;
  api.electron.app.quit();
  api.electron.app.quit();
  await tick();
  assert.equal(requests.length, 0);
  assert.equal(api.electron.app.completedQuits, 0);
  release.resolve();
  await fileOperation;
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reason, 'quit');
  assert.equal(win.isEnabled(), false);
  ack(requests[0]);
  await tick();
  assert.equal(api.electron.app.completedQuits, 1);
  assert.equal(api.electron.app.quitAttempts, 3);
});

test('quit adopts an earlier local close without closing any window before every fresh save succeeds', async () => {
  const release = deferred();
  const { api, requests, windows: [first, second], ready, ack } = setup({ shell: {
    trashItem: async () => { await release.promise; },
  } }, 2);
  ready(first);
  ready(second);
  first.close();
  first.close();
  const operation = api.invokeFrom(second, 'fs:trash', ['/fixture']);
  api.electron.app.quit();
  ack(requests[0]);
  await tick();
  assert.equal(first.isDestroyed(), false);
  assert.equal(requests.length, 1);
  release.resolve();
  await operation;
  await tick();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.slice(1).map((request) => request.reason), ['quit', 'quit']);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  ack(requests[1]);
  await tick();
  assert.equal(first.isDestroyed(), false);
  ack(requests[2], { ok: false, error: 'second window could not save' });
  await tick();
  assert.equal(api.electron.app.completedQuits, 0);
  assert.equal(first.isDestroyed(), false);
  assert.equal(second.isDestroyed(), false);
  assert.equal(first.isEnabled(), true, 'quit inherited the pre-close enabled state');
  assert.equal(second.isEnabled(), true);
  assert.equal(api.dialogs.length, 1);
  api.electron.app.quit();
  await tick();
  ack(requests[3]);
  ack(requests[4]);
  await tick();
  assert.equal(api.electron.app.completedQuits, 1);
  assert.equal(api.windows.length, 0);
});

test('a local save failure during quit is reported once and preserves every window', async () => {
  const release = deferred();
  const { api, requests, windows: [first, second], ready, ack } = setup({ shell: {
    trashItem: async () => { await release.promise; },
  } }, 2);
  ready(first);
  ready(second);
  first.close();
  const operation = api.invokeFrom(second, 'fs:trash', ['/fixture']);
  api.electron.app.quit();
  ack(requests[0], { ok: false, error: 'local save failed' });
  await tick();
  assert.equal(api.dialogs.length, 0);
  release.resolve();
  await operation;
  await tick();
  assert.equal(api.dialogs.length, 1);
  assert.equal(api.windows.length, 2);
  assert.equal(first.isEnabled(), true);
  assert.equal(second.isEnabled(), true);
});

test('a document changed after its quit ACK prevents all windows from closing', async () => {
  const { api, requests, windows: [first, second], ready, ack } = setup({}, 2);
  ready(first);
  ready(second);
  api.electron.app.quit();
  await tick();
  ack(requests[0]);
  first.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  ack(requests[1]);
  await tick();
  assert.equal(api.electron.app.completedQuits, 0);
  assert.equal(api.windows.length, 2);
  assert.equal(first.isEnabled(), true);
  assert.equal(second.isEnabled(), true);
  assert.equal(api.dialogs.length, 1);
});

test('helper auto renderer mode is explicit and follows the normal ready and ACK IPC path', async () => {
  const api = loadMain({ rendererSettings: 'auto' });
  api.ready();
  await tick();
  api.electron.app.quit();
  await tick();
  assert.equal(api.electron.app.completedQuits, 1);
  assert.equal(api.windows.length, 0);
});
