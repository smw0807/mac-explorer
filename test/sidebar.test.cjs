const test = require('node:test');
const assert = require('node:assert/strict');
const { mountComponent, file, deferred, flush, click } = require('./helpers/ui.cjs');

const directory = (name, parent = '/test', options = {}) => file(name, { path: `${parent}/${name}`, isDir: true, ...options });
const listing = (...entries) => ({ ok: true, entries });

function mountSidebar(api = {}) {
  return mountComponent('src/components/Sidebar.jsx', {
    props: {
      special: { home: '/test', volumes: [] }, currentPath: '/test', favorites: [],
      onNavigate() {}, onAddFavorite() {}, onRemoveFavorite() {},
    },
    api,
  });
}

function row(ui, name) {
  return ui.queryAll('.tree-name').find((node) => node.title === name)?.closest('.tree-row');
}

function toggle(ui, name = '홈') {
  return click(row(ui, name).querySelector('.tree-arrow'));
}

function changed(dirs) {
  return flush(() => window.dispatchEvent(new CustomEvent('mx-fs-changed', { detail: { dirs } })));
}

test('Sidebar re-reads every expansion and filters and sorts visible directories', async (t) => {
  let reads = 0;
  const ui = await mountSidebar({ readDir: async () => ++reads === 1
    ? listing(directory('folder10'), file('file.txt'), directory('.hidden'), directory('Editor.app'), directory('folder2'))
    : listing(directory('new-folder')) });
  t.after(() => ui.unmount());
  assert.equal(reads, 0);
  await toggle(ui);
  assert.deepEqual(ui.queryAll('.tree-name').map((node) => node.title), ['홈', 'folder2', 'folder10', 'Macintosh HD']);
  await toggle(ui);
  await toggle(ui);
  assert.equal(reads, 2);
  assert.ok(row(ui, 'new-folder'));
  assert.equal(row(ui, 'folder2'), undefined);
});

test('Sidebar displays an IPC failure and retries without caching it as an empty folder', async (t) => {
  let reads = 0;
  const ui = await mountSidebar({ readDir: async () => ++reads === 1
    ? { ok: false, error: 'permission denied' } : listing(directory('recovered')) });
  t.after(() => ui.unmount());
  await toggle(ui);
  assert.equal(ui.query('[role="alert"] span').title, 'permission denied');
  await click(ui.query('.tree-retry'));
  assert.equal(reads, 2);
  assert.ok(row(ui, 'recovered'));
  assert.equal(ui.query('[role="alert"]'), null);
});

test('Sidebar catches rejected reads and a later expansion retries them', async (t) => {
  let reads = 0;
  const ui = await mountSidebar({ readDir: async () => {
    if (++reads === 1) throw new Error('connection lost');
    return listing(directory('recovered'));
  } });
  t.after(() => ui.unmount());
  await toggle(ui);
  assert.equal(ui.query('[role="alert"] span').title, 'connection lost');
  await toggle(ui);
  await toggle(ui);
  assert.equal(reads, 2);
  assert.ok(row(ui, 'recovered'));
});

test('Sidebar ignores a read that completes after its branch is collapsed and reopened', async (t) => {
  const old = deferred();
  const latest = deferred();
  let reads = 0;
  const ui = await mountSidebar({ readDir: () => ++reads === 1 ? old.promise : latest.promise });
  t.after(() => ui.unmount());
  await toggle(ui);
  await toggle(ui);
  await toggle(ui);
  await flush(() => latest.resolve(listing(directory('latest'))));
  await flush(() => old.resolve(listing(directory('stale'))));
  assert.ok(row(ui, 'latest'));
  assert.equal(row(ui, 'stale'), undefined);
  assert.equal(reads, 2);
});

test('Sidebar refreshes related expanded nodes for filesystem and watcher events only', async (t) => {
  const reads = [];
  const ui = await mountSidebar({ readDir: async (p) => {
    reads.push(p);
    return p === '/test' ? listing(directory('child')) : listing();
  } });
  t.after(() => ui.unmount());
  await toggle(ui);
  await toggle(ui, 'child');
  reads.length = 0;
  await changed(['/test-other']);
  await ui.emitDirectory({ paneId: 'another-pane', dir: '/elsewhere' });
  assert.deepEqual(reads, []);
  await changed(['/test/child']);
  assert.deepEqual(reads, ['/test', '/test/child']);
  reads.length = 0;
  await ui.emitDirectory({ paneId: 'another-pane', dir: '/test/' });
  assert.deepEqual(reads, ['/test', '/test/child']);
  reads.length = 0;
  await toggle(ui);
  await changed(['/test']);
  await ui.emitDirectory({ dir: '/test/child' });
  assert.deepEqual(reads, []);
  await toggle(ui);
  assert.deepEqual(reads, ['/test']);
  assert.equal(row(ui, 'child').querySelector('.tree-arrow').classList.contains('open'), false);
});

test('Sidebar keeps the newest refresh when an older read later fails', async (t) => {
  const old = deferred();
  const latest = deferred();
  let reads = 0;
  const ui = await mountSidebar({ readDir: () => {
    reads += 1;
    return reads === 1 ? Promise.resolve(listing(directory('initial'))) : reads === 2 ? old.promise : latest.promise;
  } });
  t.after(() => ui.unmount());
  await toggle(ui);
  await changed(['/test']);
  await ui.emitDirectory({ dir: '/test' });
  await flush(() => latest.resolve(listing(directory('latest'))));
  await flush(() => old.reject(new Error('stale failure')));
  assert.ok(row(ui, 'latest'));
  assert.equal(row(ui, 'initial'), undefined);
  assert.equal(ui.query('[role="alert"]'), null);
});

test('Sidebar removes vanished subtrees and rejects their pending child reads', async (t) => {
  const pending = deferred();
  let homeReads = 0;
  let childReads = 0;
  const ui = await mountSidebar({ readDir: (p) => {
    if (p === '/test') return Promise.resolve(++homeReads === 2 ? listing() : listing(directory('child')));
    childReads += 1;
    return pending.promise;
  } });
  t.after(() => ui.unmount());
  await toggle(ui);
  await toggle(ui, 'child');
  await changed(['/test']);
  assert.equal(row(ui, 'child'), undefined);
  await flush(() => pending.resolve(listing(directory('stale-grandchild', '/test/child'))));
  await changed(['/test']);
  assert.ok(row(ui, 'child'));
  assert.equal(row(ui, 'child').querySelector('.tree-arrow').classList.contains('open'), false);
  assert.equal(row(ui, 'stale-grandchild'), undefined);
  assert.equal(childReads, 2); // Its refresh was invalidated when the parent removed it.
});

test('Sidebar clears old children when a refresh fails and retry shows the current listing', async (t) => {
  let reads = 0;
  const ui = await mountSidebar({ readDir: async () => {
    reads += 1;
    if (reads === 2) return { ok: false, error: 'directory unavailable' };
    return listing(directory(reads === 1 ? 'old' : 'new'));
  } });
  t.after(() => ui.unmount());
  await toggle(ui);
  await changed(['/test']);
  assert.equal(row(ui, 'old'), undefined);
  assert.ok(ui.query('[role="alert"]'));
  await click(ui.query('.tree-retry'));
  assert.ok(row(ui, 'new'));
});

test('Sidebar invalidates pending reads and unsubscribes on unmount', async () => {
  const pending = deferred();
  let reads = 0;
  let unsubscribed = 0;
  let listener;
  const ui = await mountSidebar({
    readDir: () => { reads += 1; return pending.promise; },
    onDirChanged: (callback) => { listener = callback; return () => { unsubscribed += 1; }; },
  });
  await toggle(ui);
  await ui.unmount();
  await changed(['/test']);
  await flush(() => listener({ dir: '/test' }));
  await flush(() => pending.reject(new Error('late failure')));
  assert.equal(reads, 1);
  assert.equal(unsubscribed, 1);
  assert.equal(ui.container.innerHTML, '');
});
