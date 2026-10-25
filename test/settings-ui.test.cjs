const test = require('node:test');
const assert = require('node:assert/strict');
const { loadComponent, mountApp, deferred, flush, click } = require('./helpers/ui.cjs');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { flushSync } = require('react-dom');

const favorites = [
  { icon: '🏠', name: '홈', path: '/test' },
  { icon: '📁', name: '폴더', path: '/test/folder' },
];
const restored = { favorites, session: { tabs: [{ dual: false, paths: ['/test'] }], active: 0, showHidden: false } };
const settingsGet = async () => ({ ok: true, settings: restored });
const hiddenButton = (ui) => ui.query('[title="숨김 파일 표시 (⇧⌘.)"]');
const dualButton = (ui) => ui.query('[title="듀얼 패널 (⇧⌘D)"]');
async function removeFirstFavorite(ui) {
  await flush(() => ui.query('.sb-item').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await click(ui.query('.cm-item'));
}

async function mutateSession(ui) {
  await removeFirstFavorite(ui);
  await click(ui.query('.sb-item'));
  await click(ui.query('.tab-add'));
  await click(dualButton(ui));
  await click(hiddenButton(ui));
}

const finalSnapshot = {
  favorites: [favorites[1]],
  session: {
    tabs: [{ dual: false, paths: ['/test/folder'] }, { dual: true, paths: ['/test/folder', '/test/folder'] }],
    active: 1,
    showHidden: true,
  },
};

test('settings readiness waits for restoration and is announced only after the flush subscription exists', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = deferred();
  const exists = deferred();
  let listener;
  let readyCalls = 0;
  const writes = [];
  const ui = await mountApp({ api: {
    settingsGet: () => saved.promise,
    exists: () => exists.promise,
    onSettingsFlush: (callback) => { listener = callback; return () => { listener = null; }; },
    settingsReady: async () => { assert.equal(typeof listener, 'function'); readyCalls += 1; return { ok: true }; },
    settingsSet: async (value) => { writes.push(value); return { ok: true }; },
  } });
  t.after(() => ui.unmount());
  assert.equal(readyCalls, 0);
  assert.equal((await listener({ reason: 'close' })).ok, false);
  await flush(() => saved.resolve({ ok: true, settings: restored }));
  assert.equal(readyCalls, 0);
  t.mock.timers.tick(500);
  await flush();
  assert.deepEqual(writes, []);
  await flush(() => exists.resolve({ exists: true, isDir: true }));
  assert.equal(readyCalls, 1);
  await flush(() => t.mock.timers.tick(500));
  assert.deepEqual(writes, [restored]);
  await click(hiddenButton(ui));
  assert.equal(readyCalls, 1);
});

test('favorite and session edits are saved together in one latest snapshot after the debounce', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  const ui = await mountApp({ api: { settingsGet, settingsSet: async (value) => { writes.push(value); return { ok: true }; } } });
  t.after(() => ui.unmount());
  await mutateSession(ui);
  assert.deepEqual(writes, []);
  await flush(() => t.mock.timers.tick(499));
  assert.deepEqual(writes, []);
  await flush(() => t.mock.timers.tick(1));
  assert.deepEqual(writes, [finalSnapshot]);
});

for (const reason of ['close', 'quit']) {
  test(`${reason} flush saves all recent settings before the debounce deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const writes = [];
    const ui = await mountApp({ api: { settingsGet, settingsSet: async (value) => { writes.push(value); return { ok: true }; } } });
    t.after(() => ui.unmount());
    await mutateSession(ui);
    assert.deepEqual(writes, []);
    assert.deepEqual(await ui.requestSettingsFlush(reason), [{ ok: true }]);
    assert.deepEqual(writes, [finalSnapshot]);
    await flush(() => t.mock.timers.tick(500));
    assert.equal(writes.length, 1);
  });
}

test('close flush waits for the active write and then the newest settings without parallel IPC writes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred();
  const last = deferred();
  const writes = [];
  let listener;
  const ui = await mountApp({ api: {
    settingsGet,
    onSettingsFlush: (callback) => { listener = callback; return () => {}; },
    settingsSet: (value) => { writes.push(value); return writes.length === 1 ? first.promise : last.promise; },
  } });
  t.after(() => ui.unmount());
  await flush(() => t.mock.timers.tick(500));
  await click(hiddenButton(ui));
  await click(ui.query('.tab-add'));
  let closing;
  await flush(() => { closing = listener({ reason: 'close' }); });
  assert.equal(writes.length, 1);
  let closed = false;
  closing.then(() => { closed = true; });
  await flush(() => first.resolve({ ok: true }));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].session.showHidden, true);
  assert.equal(writes[1].session.tabs.length, 2);
  assert.equal(closed, false);
  await flush(() => last.resolve({ ok: true }));
  assert.deepEqual(await closing, { ok: true });
  assert.equal(closed, true);
});

for (const rejection of [false, true]) {
  test(`settings ${rejection ? 'IPC rejection' : 'save failure'} shows a retryable banner and preserves newer edits`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const retry = deferred();
    const writes = [];
    const ui = await mountApp({ api: {
      settingsGet,
      settingsSet: async (value) => {
        writes.push(value);
        if (writes.length > 1) return retry.promise;
        if (rejection) throw new Error('disk is full');
        return { ok: false, error: 'disk is full' };
      },
    } });
    t.after(() => ui.unmount());
    await click(hiddenButton(ui));
    assert.deepEqual(await ui.requestSettingsFlush(), [{ ok: false, error: 'disk is full' }]);
    assert.match(ui.query('.settings-status').textContent, /disk is full/);
    await flush(() => t.mock.timers.tick(5000));
    assert.equal(writes.length, 1, 'a failed close must not loop retry writes');
    await removeFirstFavorite(ui);
    await click(ui.query('.settings-status button'));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].favorites, [favorites[1]]);
    assert.equal(writes[1].session.showHidden, true);
    assert.equal(ui.query('.settings-status button').disabled, true);
    await flush(() => retry.resolve({ ok: true }));
    assert.equal(ui.query('.settings-status'), null);
    assert.deepEqual(await ui.requestSettingsFlush(), [{ ok: true }]);
    assert.equal(writes.length, 2);
  });
}

test('favorites added through drop are deduplicated and included with the latest session save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  const ui = await mountApp({ api: {
    settingsGet: async () => ({ settings: { favorites: [] } }),
    settingsSet: async (value) => { writes.push(value); return { ok: true }; },
  } });
  t.after(() => ui.unmount());
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { getData: () => JSON.stringify(['/new', '/new']), files: [] } });
  await flush(() => ui.query('.sb-section').dispatchEvent(event));
  await click(hiddenButton(ui));
  assert.equal(ui.queryAll('.sb-item').length, 1);
  assert.equal(writes.length, 0, 'updaters do not directly write settings');
  await ui.requestSettingsFlush();
  assert.deepEqual(writes[0].favorites, [{ icon: '📁', name: 'new', path: '/new' }]);
  assert.equal(writes[0].session.showHidden, true);
});

for (const stage of ['specialDirs', 'settingsGet', 'exists']) {
  test(`unmount during ${stage} restoration prevents subsequent readiness and settings writes`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = deferred();
    let readies = 0;
    let writes = 0;
    const api = {
      settingsGet,
      settingsReady: async () => { readies += 1; return { ok: true }; },
      settingsSet: async () => { writes += 1; return { ok: true }; },
      [stage]: () => pending.promise,
    };
    const ui = await mountApp({ api });
    await ui.unmount();
    await flush(() => pending.resolve(stage === 'specialDirs' ? { home: '/test' }
      : stage === 'settingsGet' ? { settings: restored } : { exists: true, isDir: true }));
    await flush(() => t.mock.timers.tick(500));
    assert.equal(readies, 0);
    assert.equal(writes, 0);
  });
}

test('initial settings read failure can be retried without overwriting the unread saved settings', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  let readies = 0;
  const writes = [];
  const ui = await mountApp({ api: {
    settingsGet: async () => ++reads === 1 ? { ok: false, error: 'settings unavailable' } : { settings: restored },
    settingsReady: async () => { readies += 1; return { ok: true }; },
    settingsSet: async (value) => { writes.push(value); return { ok: true }; },
  } });
  t.after(() => ui.unmount());
  assert.match(ui.query('[role="alert"]').textContent, /settings unavailable/);
  await flush(() => t.mock.timers.tick(1000));
  assert.equal(writes.length, 0);
  assert.equal(readies, 0);
  await click(ui.query('.loading-app button'));
  assert.equal(ui.query('.loading-app'), null);
  assert.equal(readies, 1);
  assert.deepEqual(await ui.requestSettingsFlush(), [{ ok: true }]);
  assert.deepEqual(writes, [restored]);
});

test('a readiness IPC failure is visible and retry restores the handshake before saving', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let readies = 0;
  const writes = [];
  const ui = await mountApp({ api: {
    settingsGet,
    settingsReady: async () => { if (++readies === 1) throw new Error('ready unavailable'); return { ok: true }; },
    settingsSet: async (value) => { writes.push(value); return { ok: true }; },
  } });
  t.after(() => ui.unmount());
  assert.match(ui.query('.settings-status').textContent, /ready unavailable/);
  await click(hiddenButton(ui));
  await click(ui.query('.settings-status button'));
  assert.equal(readies, 2);
  assert.equal(ui.query('.settings-status'), null);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].session.showHidden, true);
});

test('a remounted settings hook cannot be marked ready by the previous instance microtask', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const useSettingsPersistence = loadComponent('src/hooks/useSettingsPersistence.js');
  let readies = 0;
  let writes = 0;
  let subscribed = false;
  window.api = {
    onSettingsFlush: () => { subscribed = true; return () => { subscribed = false; }; },
    settingsReady: async () => { assert.equal(subscribed, true); readies += 1; return { ok: true }; },
    settingsSet: async () => { writes += 1; return { ok: true }; },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await flush(() => root.unmount()); container.remove(); });
  function Harness({ snapshot, remount }) {
    // Queue the remount before announceReady's Promise callback, after effects exist.
    React.useEffect(() => { if (remount) queueMicrotask(remount); }, [remount]);
    useSettingsPersistence(snapshot);
    return null;
  }
  const remount = () => flushSync(() => root.render(React.createElement(Harness, { key: 'new', snapshot: null })));
  await flush(() => root.render(React.createElement(Harness, { key: 'old', snapshot: restored, remount })));
  assert.equal(readies, 0, 'old readiness must not enable the new subscription before restoration');
  await flush(() => t.mock.timers.tick(500));
  assert.equal(writes, 0);
  await flush(() => root.render(React.createElement(Harness, { key: 'new', snapshot: restored })));
  assert.equal(readies, 1);
  await flush(() => t.mock.timers.tick(500));
  assert.equal(writes, 1);
});
