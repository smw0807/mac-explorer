const test = require('node:test');
const assert = require('node:assert/strict');
const { mountPane, mountApp, file, deferred, flush, click, key, changeValue } = require('./helpers/ui.cjs');

test('filtering out a selected file excludes it from delete, copy, and cut', async (t) => {
  const trashed = [];
  const clipboard = [];
  const ui = await mountPane({
    entries: [file('alpha.txt'), file('beta.txt')],
    props: { setClipboard: (value) => clipboard.push(value) },
    api: { trash: async (paths) => { trashed.push(paths); return { ok: true }; } },
  });
  t.after(() => ui.unmount());

  await click(ui.query('.fl-row'));
  assert.match(ui.query('.statusbar').textContent, /1개 선택됨/);
  await changeValue(ui.query('.search-input'), 'beta');
  assert.deepEqual(ui.queryAll('.fl-name').map((node) => node.textContent), ['beta.txt']);
  assert.doesNotMatch(ui.query('.statusbar').textContent, /선택됨/);

  // Move keyboard focus without clicking the list, which would clear selection itself.
  ui.query('.pane').focus();
  await key(ui.query('.pane'), 'c', { metaKey: true });
  await key(ui.query('.pane'), 'x', { metaKey: true });
  await key(ui.query('.pane'), 'Delete');
  assert.deepEqual(clipboard, []);
  assert.deepEqual(trashed, []);
});

test('filtered multi-selection applies copy, cut, and delete only to visible files', async (t) => {
  const trashed = [];
  const clipboard = [];
  const ui = await mountPane({
    entries: [file('alpha.txt'), file('beta.txt')],
    props: { setClipboard: (value) => clipboard.push(value) },
    api: { trash: async (paths) => { trashed.push(paths); return { ok: true }; } },
  });
  t.after(() => ui.unmount());

  await key(ui.query('.pane'), 'a', { metaKey: true });
  assert.match(ui.query('.statusbar').textContent, /2개 선택됨/);
  await changeValue(ui.query('.search-input'), 'beta');
  assert.match(ui.query('.statusbar').textContent, /1개 선택됨/);
  await key(ui.query('.pane'), 'c', { metaKey: true });
  await key(ui.query('.pane'), 'x', { metaKey: true });
  await key(ui.query('.pane'), 'Delete');

  assert.deepEqual(clipboard, [
    { mode: 'copy', paths: ['/test/beta.txt'] },
    { mode: 'cut', paths: ['/test/beta.txt'] },
  ]);
  assert.deepEqual(trashed, [['/test/beta.txt']]);
});

test('turning off hidden files removes hidden selections from destructive actions', async (t) => {
  const trashed = [];
  const clipboard = [];
  const ui = await mountPane({
    entries: [file('.secret.txt'), file('visible.txt')],
    props: { showHidden: true, setClipboard: (value) => clipboard.push(value) },
    api: { trash: async (paths) => { trashed.push(paths); return { ok: true }; } },
  });
  t.after(() => ui.unmount());

  const hiddenRow = ui.queryAll('.fl-row').find((row) => row.textContent.includes('.secret.txt'));
  await click(hiddenRow);
  await ui.update({ showHidden: false });
  assert.deepEqual(ui.queryAll('.fl-name').map((node) => node.textContent), ['visible.txt']);
  await key(ui.query('.pane'), 'c', { metaKey: true });
  await key(ui.query('.pane'), 'x', { metaKey: true });
  await key(ui.query('.pane'), 'Backspace', { metaKey: true });
  assert.deepEqual(clipboard, []);
  assert.deepEqual(trashed, []);
});

test('deleting an ordinary visible selection still trashes exactly that file', async (t) => {
  const trashed = [];
  const ui = await mountPane({
    entries: [file('alpha.txt'), file('beta.txt')],
    api: { trash: async (paths) => { trashed.push(paths); return { ok: true }; } },
  });
  t.after(() => ui.unmount());

  await click(ui.query('.fl-row'));
  await key(ui.query('.pane'), 'Backspace', { metaKey: true });
  assert.deepEqual(trashed, [['/test/alpha.txt']]);
  assert.doesNotMatch(ui.query('.statusbar').textContent, /선택됨/);
});

const visiblePane = (ui) => ui.query('.panes:not([hidden]) .pane');

async function copySelectedFile(ui) {
  await click(visiblePane(ui).querySelector('.fl-row'));
  await key(visiblePane(ui), 'c', { metaKey: true });
}

test('switching tabs preserves the current directory, history, and view without remounting', async (t) => {
  const unwatched = [];
  const ui = await mountApp({
    api: {
      readDir: async (directory) => ({ ok: true, entries: directory === '/test' ? [file('child', { isDir: true })] : [] }),
      unwatchDir: async (paneId) => { unwatched.push(paneId); return { ok: true }; },
    },
  });
  t.after(() => ui.unmount());
  const firstPane = visiblePane(ui);
  await click(firstPane.querySelector('.fl-row'));
  await key(firstPane, 'Enter');
  assert.equal(firstPane.querySelector('.bc-seg:last-child').textContent, 'child');
  await click(firstPane.querySelector('[title="아이콘 보기"]'));
  assert.ok(firstPane.querySelector('.fl-rows.grid'));
  const watchesBeforeSwitch = unwatched.length;

  await click(ui.query('.tab-add'));
  assert.equal(ui.queryAll('.pane').length, 2);
  assert.equal(firstPane.closest('.panes').hidden, true);
  assert.equal(unwatched.length, watchesBeforeSwitch);
  await click(ui.queryAll('.tab')[0]);

  assert.equal(visiblePane(ui), firstPane);
  assert.equal(firstPane.querySelector('.bc-seg:last-child').textContent, 'child');
  assert.ok(firstPane.querySelector('.fl-rows.grid'));
  assert.equal(firstPane.querySelector('[title="뒤로"]').disabled, false);
  await click(firstPane.querySelector('[title="뒤로"]'));
  assert.equal(firstPane.querySelector('.bc-seg:last-child').textContent, 'test');
});

test('a copy can finish and be undone after its originating tab closes', async (t) => {
  const trashed = [];
  const reads = [];
  const unwatched = [];
  const ui = await mountApp({
    api: {
      readDir: async (directory) => { reads.push(directory); return { ok: true, entries: [file('source.txt')] }; },
      copyStart: async () => ({ ok: true, jobId: 101 }),
      trash: async (paths) => { trashed.push(paths); return { ok: true }; },
      unwatchDir: async (paneId) => { unwatched.push(paneId); return { ok: true }; },
    },
  });
  t.after(() => ui.unmount());
  await copySelectedFile(ui);
  await key(visiblePane(ui), 'v', { metaKey: true });
  assert.ok(ui.query('.copy-progress[data-job-id="101"]'));
  await click(ui.query('.tab-add'));
  await click(ui.queryAll('.tab')[0].querySelector('.tab-close'));
  assert.equal(ui.queryAll('.pane').length, 1);
  assert.equal(unwatched.length, 1);
  assert.ok(ui.query('.copy-progress[data-job-id="101"]'));
  const readsBeforeDone = reads.length;

  await ui.emitCopy({ jobId: 101, destDir: '/test', done: true, created: ['/test/copied.txt'] });
  assert.equal(ui.query('.copy-progress'), null);
  assert.ok(reads.length > readsBeforeDone, 'the destination refreshes when the job completes');
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(trashed, [['/test/copied.txt']]);
});

test('multiple copy jobs remain independently cancelable after the originating dual pane is removed', async (t) => {
  let jobId = 200;
  const canceled = [];
  const ui = await mountApp({
    entries: [file('source.txt')],
    api: {
      copyStart: async () => ({ ok: true, jobId: ++jobId }),
      copyCancel: async (id) => { canceled.push(id); return { ok: true }; },
    },
  });
  t.after(() => ui.unmount());
  await click(ui.query('[title="듀얼 패널 (⇧⌘D)"]'));
  const secondPane = ui.queryAll('.panes:not([hidden]) .pane')[1];
  await click(secondPane.querySelector('.fl-row'));
  await key(secondPane, 'c', { metaKey: true });
  await key(secondPane, 'v', { metaKey: true });
  await key(secondPane, 'v', { metaKey: true });
  assert.equal(ui.queryAll('.copy-progress').length, 2);
  await ui.emitCopy({ jobId: 202, destDir: '/test', copied: 50, total: 100, currentFile: '/test/source.txt' });
  assert.equal(ui.query('[data-job-id="202"] .cp-fill').style.width, '50%');
  await click(ui.query('[title="듀얼 패널 (⇧⌘D)"]'));
  assert.equal(ui.queryAll('.pane').length, 1);

  await click(ui.query('[data-job-id="201"] .cp-cancel'));
  assert.deepEqual(canceled, [201]);
  assert.equal(ui.query('[data-job-id="201"] .cp-cancel').disabled, true);
  await ui.emitCopy({ jobId: 201, destDir: '/test', done: true, canceled: true, created: [] });
  assert.equal(ui.query('[data-job-id="201"]'), null);
  assert.ok(ui.query('[data-job-id="202"]'));
  await click(ui.query('[data-job-id="202"] .cp-cancel'));
  await ui.emitCopy({ jobId: 202, destDir: '/test', done: true, canceled: true, created: [] });
  assert.deepEqual(canceled, [201, 202]);
  assert.equal(ui.query('.copy-jobs'), null);
});

test('completion before the copyStart response is recorded once and never restores a progress row', async (t) => {
  const response = deferred();
  const trashed = [];
  const ui = await mountApp({
    entries: [file('source.txt')],
    api: {
      copyStart: () => response.promise,
      trash: async (paths) => { trashed.push(paths); return { ok: true }; },
    },
  });
  t.after(() => ui.unmount());
  await copySelectedFile(ui);
  await key(visiblePane(ui), 'v', { metaKey: true });
  const done = { jobId: 301, destDir: '/test', done: true, created: ['/test/fast.txt'] };
  await ui.emitCopy(done);
  await flush(() => response.resolve({ ok: true, jobId: 301 }));
  await ui.emitCopy(done);
  assert.equal(ui.query('.copy-progress'), null);
  await key(visiblePane(ui), 'z', { metaKey: true });
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(trashed, [['/test/fast.txt']]);
});

test('completed items from a canceled copy remain undoable', async (t) => {
  const trashed = [];
  const ui = await mountApp({
    entries: [file('source.txt')],
    api: {
      copyStart: async () => ({ ok: true, jobId: 401 }),
      trash: async (paths) => { trashed.push(paths); return { ok: true }; },
    },
  });
  t.after(() => ui.unmount());
  await copySelectedFile(ui);
  await key(visiblePane(ui), 'v', { metaKey: true });
  await ui.emitCopy({ jobId: 401, destDir: '/test', done: true, canceled: true, created: ['/test/completed.txt'] });
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(trashed, [['/test/completed.txt']]);
});
