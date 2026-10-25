const test = require('node:test');
const assert = require('node:assert/strict');
const { mountComponent, mountPane, mountApp, file, deferred, flush, click, key, changeValue } = require('./helpers/ui.cjs');

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
const undoEntry = (token, path = '/test/result') => ({ path, token });

function captureChanges(t) {
  const changes = [];
  const onChanged = (event) => changes.push(event.detail.dirs);
  window.addEventListener('mx-fs-changed', onChanged);
  t.after(() => window.removeEventListener('mx-fs-changed', onChanged));
  return changes;
}

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
  const undone = [];
  const reads = [];
  const unwatched = [];
  const ui = await mountApp({
    api: {
      readDir: async (directory) => { reads.push(directory); return { ok: true, entries: [file('source.txt')] }; },
      copyStart: async () => ({ ok: true, jobId: 101 }),
      undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/test'] }; },
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

  await ui.emitCopy({ jobId: 101, destDir: '/test', done: true, created: ['/test/copied.txt'], undo: [undoEntry('closed-tab-copy', '/test/copied.txt')] });
  assert.equal(ui.query('.copy-progress'), null);
  assert.ok(reads.length > readsBeforeDone, 'the destination refreshes when the job completes');
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(undone, ['closed-tab-copy']);
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
  const undone = [];
  const ui = await mountApp({
    entries: [file('source.txt')],
    api: {
      copyStart: () => response.promise,
      undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/test'] }; },
    },
  });
  t.after(() => ui.unmount());
  await copySelectedFile(ui);
  await key(visiblePane(ui), 'v', { metaKey: true });
  const done = { jobId: 301, destDir: '/test', done: true, created: ['/test/fast.txt'], undo: [undoEntry('fast-copy', '/test/fast.txt')] };
  await ui.emitCopy(done);
  await flush(() => response.resolve({ ok: true, jobId: 301 }));
  await ui.emitCopy(done);
  assert.equal(ui.query('.copy-progress'), null);
  await key(visiblePane(ui), 'z', { metaKey: true });
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(undone, ['fast-copy']);
});

test('completed items from a canceled copy remain undoable', async (t) => {
  const undone = [];
  const ui = await mountApp({
    entries: [file('source.txt')],
    api: {
      copyStart: async () => ({ ok: true, jobId: 401 }),
      undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/test'] }; },
    },
  });
  t.after(() => ui.unmount());
  await copySelectedFile(ui);
  await key(visiblePane(ui), 'v', { metaKey: true });
  await ui.emitCopy({ jobId: 401, destDir: '/test', done: true, canceled: true, created: ['/test/completed.txt'], undo: [undoEntry('partial-copy', '/test/completed.txt')] });
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(undone, ['partial-copy']);
});

test('failed copy completion records only its backend tokens and tokenless completions cannot be undone', async (t) => {
  const undone = [];
  const ui = await mountApp({ api: {
    undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/test'] }; },
    trash: () => assert.fail('copy undo must not delete by path'),
  } });
  t.after(() => ui.unmount());
  await ui.emitCopy({ jobId: 450, destDir: '/test', done: true, created: ['/test/untracked.txt'] });
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(undone, []);
  await ui.emitCopy({
    jobId: 451, destDir: '/test', done: true, error: 'second file failed',
    created: ['/test/completed.txt'], undo: [undoEntry('failed-job-success', '/test/completed.txt')],
  });
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(undone, ['failed-job-success']);
  assert.match(ui.alerts[0], /second file failed/);
});

test('inline rename records the backend token without constructing an inverse rename', async (t) => {
  const changes = captureChanges(t);
  const renamed = [];
  const undone = [];
  const ui = await mountApp({ entries: [file('old.txt')], api: {
    rename: async (from, name) => {
      renamed.push([from, name]);
      return { ok: true, path: '/test/new.txt', undo: [undoEntry('inline-rename', '/test/new.txt')] };
    },
    undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/test'] }; },
  } });
  t.after(() => ui.unmount());
  await click(visiblePane(ui).querySelector('.fl-row'));
  await key(visiblePane(ui), 'F2');
  await changeValue(ui.query('.rename-input'), 'new.txt');
  await key(ui.query('.rename-input'), 'Enter');
  assert.deepEqual(changes, [['/test']]);
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(renamed, [['/test/old.txt', 'new.txt']]);
  assert.deepEqual(undone, ['inline-rename']);
});

test('partially successful batch rename combines its tokens into one reverse-order undo', async (t) => {
  const changes = captureChanges(t);
  const renamed = [];
  const undone = [];
  const ui = await mountApp({ entries: ['a', 'b', 'c'].map((name) => file(`old-${name}.txt`)), api: {
    rename: async (from, name) => {
      renamed.push([from, name]);
      if (name === 'new-c.txt') return { ok: false, error: 'c is busy' };
      return { ok: true, path: `/test/${name}`, undo: [undoEntry(`batch-${name}`, `/test/${name}`)] };
    },
    undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/test'] }; },
  } });
  t.after(() => ui.unmount());
  await key(visiblePane(ui), 'a', { metaKey: true });
  await flush(() => ui.query('.fl-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await click(ui.queryAll('.cm-item').find((node) => node.textContent === '일괄 이름 변경…'));
  await changeValue(ui.queryAll('.modal-fields input')[0], 'old');
  await changeValue(ui.queryAll('.modal-fields input')[1], 'new');
  await click(ui.query('.modal-actions .primary'));
  assert.match(ui.alerts[0], /c is busy/);
  assert.deepEqual(changes, [['/test']]);
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(undone, ['batch-new-b.txt', 'batch-new-a.txt']);
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.equal(undone.length, 2, 'the entire successful batch belongs to one history entry');
  assert.equal(renamed.length, 3, 'undo does not issue another rename');
});

for (const operation of ['mkdir', 'newFile', 'compress', 'extract']) {
  test(`${operation} forwards its creation token to application undo`, async (t) => {
    const changes = captureChanges(t);
    const undone = [];
    const created = file('created-result', { isDir: operation === 'mkdir' || operation === 'extract' });
    let entries = operation === 'compress' || operation === 'extract' ? [file('source.zip')] : [];
    const ui = await mountApp({ api: {
      readDir: async () => ({ ok: true, entries }),
      [operation]: async () => {
        entries = [...entries, created];
        return { ok: true, path: created.path, undo: [undoEntry(`created-by-${operation}`, created.path)] };
      },
      undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/test'] }; },
      trash: () => assert.fail('creation undo must not delete by path'),
    } });
    t.after(() => ui.unmount());
    if (operation === 'mkdir') await key(visiblePane(ui), 'N', { metaKey: true, shiftKey: true });
    else {
      const target = operation === 'newFile' ? ui.query('.filelist') : ui.query('.fl-row');
      await flush(() => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      const label = { newFile: '새 파일', compress: '압축하기', extract: '압축 해제' }[operation];
      await click(ui.queryAll('.cm-item').find((node) => node.textContent === label));
    }
    assert.deepEqual(changes, [['/test']]);
    if (ui.query('.rename-input')) await key(ui.query('.rename-input'), 'Escape');
    await key(visiblePane(ui), 'z', { metaKey: true });
    assert.deepEqual(undone, [`created-by-${operation}`]);
  });
}

const displayedNames = (ui) => ui.queryAll('.fl-name').map((node) => node.textContent);

async function searchFor(ui, query, spotlight = false) {
  await changeValue(ui.query('.search-input'), query);
  await key(ui.query('.search-input'), 'Enter', { metaKey: spotlight });
}

test('navigation immediately invalidates old directory reads before the new effect runs', async (t) => {
  const oldRead = deferred();
  const newRead = deferred();
  const stats = [];
  const ui = await mountPane({
    api: {
      readDir: (directory) => directory === '/test' ? oldRead.promise : newRead.promise,
      statfs: async (directory) => { stats.push(directory); return { ok: true, free: 2048 }; },
    },
  });
  t.after(() => ui.unmount());

  await flush(() => {
    ui.query('.bc-seg').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    oldRead.resolve({ ok: true, entries: [file('stale.txt')] });
  });
  assert.deepEqual(displayedNames(ui), []);
  await flush(() => newRead.resolve({ ok: true, entries: [file('current.txt', { path: '/current.txt' })] }));
  assert.deepEqual(displayedNames(ui), ['current.txt']);
  assert.deepEqual(stats, ['/']);
});

test('late disk statistics from the previous directory cannot overwrite the current directory', async (t) => {
  const oldDisk = deferred();
  const newDisk = deferred();
  const ui = await mountPane({
    entries: [file('current.txt')],
    api: { statfs: (directory) => directory === '/test' ? oldDisk.promise : newDisk.promise },
  });
  t.after(() => ui.unmount());
  await click(ui.query('.bc-seg'));
  await flush(() => newDisk.resolve({ ok: true, free: 2048 }));
  assert.match(ui.query('.statusbar').textContent, /2\.0 KB/);
  await flush(() => oldDisk.resolve({ ok: true, free: 999 }));
  assert.match(ui.query('.statusbar').textContent, /2\.0 KB/);
  assert.doesNotMatch(ui.query('.statusbar').textContent, /999 B/);
});

test('a newer refresh supersedes an older request for the same directory', async (t) => {
  const oldRead = deferred();
  const newRead = deferred();
  let reads = 0;
  const ui = await mountPane({
    api: { readDir: () => ++reads === 1 ? oldRead.promise : newRead.promise },
  });
  t.after(() => ui.unmount());
  await click(ui.query('[title="새로 고침"]'));
  await flush(() => newRead.resolve({ ok: true, entries: [file('new.txt')] }));
  await flush(() => oldRead.reject(new Error('outdated directory error')));
  assert.deepEqual(displayedNames(ui), ['new.txt']);
  assert.equal(ui.query('.fl-error'), null);
});

for (const cancellation of ['close', 'input Escape', 'pane Escape', 'edit query']) {
  test(`pending search stays canceled after ${cancellation}`, async (t) => {
    const result = deferred();
    const ui = await mountPane({ entries: [file('base.txt')], api: { search: () => result.promise } });
    t.after(() => ui.unmount());
    await searchFor(ui, 'old');
    assert.match(ui.query('.search-banner').textContent, /검색 중/);
    if (cancellation === 'close') await click(ui.query('.search-banner button'));
    if (cancellation === 'input Escape') await key(ui.query('.search-input'), 'Escape');
    if (cancellation === 'pane Escape') await key(ui.query('.pane'), 'Escape');
    if (cancellation === 'edit query') await changeValue(ui.query('.search-input'), 'base');
    await flush(() => result.resolve({ ok: true, entries: [file('old-result.txt')] }));
    assert.equal(ui.query('.search-banner'), null);
    assert.equal(ui.query('.search-input').value, cancellation === 'edit query' ? 'base' : '');
    assert.deepEqual(displayedNames(ui), ['base.txt']);
  });
}

test('a newer Spotlight search wins over a delayed recursive search', async (t) => {
  const oldResult = deferred();
  const ui = await mountPane({
    api: {
      search: () => oldResult.promise,
      searchSpotlight: async () => ({ ok: true, entries: [file('spotlight.txt')] }),
    },
  });
  t.after(() => ui.unmount());
  await searchFor(ui, 'old');
  await searchFor(ui, 'new', true);
  await flush(() => oldResult.resolve({ ok: true, entries: [file('old-result.txt')] }));
  assert.equal(ui.query('.search-input').value, 'new');
  assert.match(ui.query('.search-banner').textContent, /Spotlight/);
  assert.deepEqual(displayedNames(ui), ['spotlight.txt']);
});

test('navigation suppresses a delayed Spotlight search response', async (t) => {
  const result = deferred();
  const ui = await mountPane({
    api: {
      readDir: async (directory) => ({ ok: true, entries: [file(directory === '/' ? 'root.txt' : 'old.txt')] }),
      searchSpotlight: () => result.promise,
    },
  });
  t.after(() => ui.unmount());
  await searchFor(ui, 'old', true);
  await click(ui.query('.bc-seg'));
  await flush(() => result.resolve({ ok: true, entries: [file('old-result.txt')] }));
  assert.equal(ui.query('.search-banner'), null);
  assert.equal(ui.query('.search-input').value, '');
  assert.deepEqual(displayedNames(ui), ['root.txt']);
});

for (const spotlight of [false, true]) {
  test(`${spotlight ? 'Spotlight' : 'recursive'} search reruns with the current hidden-file setting`, async (t) => {
    const oldResult = deferred();
    const calls = [];
    const search = (directory, query, options) => {
      calls.push({ directory, query, options });
      return options.showHidden
        ? Promise.resolve({ ok: true, entries: [file('.secret.txt')] })
        : oldResult.promise;
    };
    const ui = await mountPane({ api: { search, searchSpotlight: search } });
    t.after(() => ui.unmount());
    await searchFor(ui, 'secret', spotlight);
    await ui.update({ showHidden: true });
    await flush(() => oldResult.resolve({ ok: true, entries: [file('outdated.txt')] }));
    assert.deepEqual(calls, [
      { directory: '/test', query: 'secret', options: { showHidden: false } },
      { directory: '/test', query: 'secret', options: { showHidden: true } },
    ]);
    assert.deepEqual(displayedNames(ui), ['.secret.txt']);
    assert.equal(ui.query('.search-input').value, 'secret');
    assert.equal(ui.query('.search-banner').textContent.includes('Spotlight'), spotlight);
  });
}

test('search reports failures and truncated results instead of showing a misleading complete result count', async (t) => {
  let calls = 0;
  const ui = await mountPane({
    api: { search: async () => ++calls === 1 ? { ok: false, error: 'permission denied' } : { ok: true, entries: [file('one.txt')], truncated: true } },
  });
  t.after(() => ui.unmount());
  await searchFor(ui, 'one');
  assert.match(ui.query('.search-banner').textContent, /검색 실패: permission denied/);
  await key(ui.query('.search-input'), 'Enter');
  assert.match(ui.query('.search-banner').textContent, /검색 결과 1개.*일부 결과만 표시/);
});

test('back and forward reset search, selection, and address editing and ignore outstanding searches', async (t) => {
  const pending = deferred();
  let calls = 0;
  const ui = await mountPane({
    api: {
      readDir: async (directory) => ({ ok: true, entries: directory === '/test' ? [file('child', { isDir: true })] : [file('child-file.txt', { path: '/test/child/child-file.txt' })] }),
      search: async () => ++calls === 1 ? { ok: true, entries: [file('result.txt')] } : pending.promise,
    },
  });
  t.after(() => ui.unmount());
  await click(ui.query('.fl-row'));
  await key(ui.query('.pane'), 'Enter');
  await searchFor(ui, 'result');
  await click(ui.query('.fl-row'));
  await key(ui.query('.pane'), 'l', { metaKey: true });
  assert.ok(ui.query('.address-input'));
  assert.match(ui.query('.statusbar').textContent, /1개 선택됨/);
  await click(ui.query('[title="뒤로"]'));
  assert.equal(ui.query('.bc-seg:last-child').textContent, 'test');
  assert.equal(ui.query('.search-banner'), null);
  assert.equal(ui.query('.search-input').value, '');
  assert.equal(ui.query('.address-input'), null);
  assert.doesNotMatch(ui.query('.statusbar').textContent, /선택됨/);

  await searchFor(ui, 'pending');
  await key(ui.query('.pane'), 'l', { metaKey: true });
  await click(ui.query('[title="앞으로"]'));
  await flush(() => pending.resolve({ ok: true, entries: [file('stale.txt')] }));
  assert.equal(ui.query('.bc-seg:last-child').textContent, 'child');
  assert.equal(ui.query('.search-banner'), null);
  assert.equal(ui.query('.search-input').value, '');
  assert.equal(ui.query('.address-input'), null);
  assert.deepEqual(displayedNames(ui), ['child-file.txt']);
});

test('text preview ignores an older file response and displays both returned and thrown read errors', async (t) => {
  const first = deferred();
  const second = deferred();
  const calls = new Map();
  const ui = await mountPane({
    entries: [file('alpha.txt'), file('beta.txt')],
    api: {
      readText: (filename) => {
        const count = (calls.get(filename) || 0) + 1;
        calls.set(filename, count);
        if (filename.endsWith('alpha.txt')) return count === 1 ? first.promise : Promise.resolve({ ok: false, error: 'read denied' });
        return count === 1 ? second.promise : Promise.reject(new Error('IPC read failed'));
      },
    },
  });
  t.after(() => ui.unmount());
  await click(ui.query('[title="미리보기 (Space)"]'));
  await click(ui.queryAll('.fl-row')[0]);
  await click(ui.queryAll('.fl-row')[1]);
  await flush(() => second.resolve({ ok: true, text: 'beta contents' }));
  await flush(() => first.resolve({ ok: true, text: 'outdated alpha contents' }));
  assert.equal(ui.query('.preview pre').textContent, 'beta contents');
  await click(ui.queryAll('.fl-row')[0]);
  assert.match(ui.query('.preview').textContent, /미리보기 실패: read denied/);
  assert.doesNotMatch(ui.query('.preview').textContent, /beta contents/);
  await click(ui.queryAll('.fl-row')[1]);
  assert.match(ui.query('.preview').textContent, /미리보기 실패: IPC read failed/);
});

test('unmount invalidates pending reads and searches without issuing follow-up disk requests', async () => {
  const read = deferred();
  const result = deferred();
  const stats = [];
  const ui = await mountPane({
    api: {
      readDir: () => read.promise,
      statfs: async (directory) => { stats.push(directory); return { ok: true, free: 1 }; },
      search: () => result.promise,
    },
  });
  await searchFor(ui, 'pending');
  await ui.unmount();
  await flush(() => {
    read.resolve({ ok: true, entries: [file('late.txt')] });
    result.reject(new Error('late search failure'));
  });
  assert.deepEqual(stats, []);
  assert.equal(ui.container.isConnected, false);
});

test('cut paste retains failed and skipped sources, excludes recovery copies, and undoes only completed moves', async (t) => {
  const sources = [file('a.txt'), file('b.txt'), file('c.txt')];
  const pasted = [];
  const restored = [];
  const ui = await mountApp({
    api: {
      readDir: async (directory) => ({ ok: true, entries: directory === '/test' ? sources : [] }),
      move: async (paths) => {
        pasted.push(paths);
        if (pasted.length === 1) return {
          ok: false,
          items: [{ from: '/test/a.txt', to: '/test/Downloads/a.txt' }],
          undo: [undoEntry('move-a', '/test/Downloads/a.txt')],
          recovery: [{ from: '/test/b.txt', to: '/test/Downloads/b.txt' }],
          error: '복구용 완성본: /test/Downloads/b.txt',
        };
        if (pasted.length === 2) return { ok: true, items: [] };
        return { ok: true, items: [{ from: '/test/c.txt', to: '/test/Downloads/c.txt' }], undo: [undoEntry('move-c', '/test/Downloads/c.txt')] };
      },
      undo: async (token) => { restored.push(token); return { ok: true, dirs: ['/test', '/test/Downloads'] }; },
    },
  });
  t.after(() => ui.unmount());
  await key(visiblePane(ui), 'a', { metaKey: true });
  await key(visiblePane(ui), 'x', { metaKey: true });
  await click(ui.queryAll('.sb-item').find((node) => node.textContent.includes('다운로드')));
  await key(visiblePane(ui), 'v', { metaKey: true });
  assert.match(visiblePane(ui).querySelector('.statusbar').textContent, /클립보드: 1개 \(잘라내기\)/);
  assert.match(ui.alerts[0], /복구용 완성본/);
  await key(visiblePane(ui), 'v', { metaKey: true });
  assert.match(visiblePane(ui).querySelector('.statusbar').textContent, /클립보드: 1개 \(잘라내기\)/);
  await key(visiblePane(ui), 'v', { metaKey: true });
  assert.doesNotMatch(visiblePane(ui).querySelector('.statusbar').textContent, /클립보드:/);
  assert.deepEqual(pasted, [['/test/a.txt', '/test/b.txt', '/test/c.txt'], ['/test/c.txt'], ['/test/c.txt']]);
  await key(visiblePane(ui), 'z', { metaKey: true });
  await key(visiblePane(ui), 'z', { metaKey: true });
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(restored, ['move-c', 'move-a']);
});

test('a delayed cut paste does not replace a newer clipboard selection', async (t) => {
  const moved = deferred();
  const copies = [];
  const ui = await mountApp({
    api: {
      readDir: async (directory) => ({ ok: true, entries: directory === '/test' ? [file('source.txt')] : [file('new-copy.txt', { path: '/test/Downloads/new-copy.txt' })] }),
      move: () => moved.promise,
      copyStart: async (paths) => { copies.push(paths); return { ok: true, jobId: 901 }; },
    },
  });
  t.after(() => ui.unmount());
  await click(visiblePane(ui).querySelector('.fl-row'));
  await key(visiblePane(ui), 'x', { metaKey: true });
  await click(ui.queryAll('.sb-item').find((node) => node.textContent.includes('다운로드')));
  await key(visiblePane(ui), 'v', { metaKey: true });
  await click(visiblePane(ui).querySelector('.fl-row'));
  await key(visiblePane(ui), 'c', { metaKey: true });
  await flush(() => moved.resolve({ ok: true, items: [{ from: '/test/source.txt', to: '/test/Downloads/source.txt' }], undo: [undoEntry('delayed-move', '/test/Downloads/source.txt')] }));
  assert.match(visiblePane(ui).querySelector('.statusbar').textContent, /클립보드: 1개 \(복사\)/);
  await key(visiblePane(ui), 'v', { metaKey: true });
  assert.deepEqual(copies, [['/test/Downloads/new-copy.txt']]);
  await ui.emitCopy({ jobId: 901, done: true, canceled: true, created: [], destDir: '/test/Downloads' });
});

test('partial trash through the context menu keeps unsuccessful selections available for retry', async (t) => {
  let entries = [file('a.txt'), file('b.txt')];
  const calls = [];
  const ui = await mountPane({
    api: {
      readDir: async () => ({ ok: true, entries }),
      trash: async (paths) => {
        calls.push(paths);
        if (calls.length === 1) {
          entries = [file('b.txt')];
          return { ok: false, trashed: ['/test/a.txt'], error: 'b is busy' };
        }
        entries = [];
        return { ok: true, trashed: paths };
      },
    },
  });
  t.after(() => ui.unmount());
  await key(ui.query('.pane'), 'a', { metaKey: true });
  await flush(() => ui.query('.fl-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await click(ui.queryAll('.cm-item').find((node) => node.textContent.includes('휴지통으로 이동')));
  assert.deepEqual(displayedNames(ui), ['b.txt']);
  assert.match(ui.query('.statusbar').textContent, /1개 선택됨/);
  assert.match(ui.alerts[0], /b is busy/);
  await key(ui.query('.pane'), 'Delete');
  assert.deepEqual(calls, [['/test/a.txt', '/test/b.txt'], ['/test/b.txt']]);
  assert.deepEqual(displayedNames(ui), []);
});

for (const kind of ['folder', 'file']) {
  test(`new ${kind} enters rename mode even when a watcher refresh supersedes its own reload`, async (t) => {
    const created = kind === 'folder' ? file('새 폴더', { isDir: true }) : file('새 파일.txt');
    const oldReload = deferred();
    let reads = 0;
    const ui = await mountPane({
      api: {
        readDir: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve({ ok: true, entries: [] });
          if (reads === 2) return oldReload.promise;
          return Promise.resolve({ ok: true, entries: [created] });
        },
        mkdir: async () => ({ ok: true, path: created.path }),
        newFile: async () => ({ ok: true, path: created.path }),
      },
    });
    t.after(() => ui.unmount());
    if (kind === 'folder') await key(ui.query('.pane'), 'N', { metaKey: true, shiftKey: true });
    else {
      await flush(() => ui.query('.filelist').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      await click(ui.queryAll('.cm-item').find((node) => node.textContent === '새 파일'));
    }
    await ui.emitDirectory({ paneId: 'test-pane', dir: '/test' });
    await flush(() => oldReload.resolve({ ok: true, entries: [created] }));
    assert.equal(ui.query('.rename-input')?.value, created.name);
  });
}

test('restoring an empty favorites list does not repopulate default favorites', async (t) => {
  const ui = await mountApp({ api: { settingsGet: async () => ({ settings: { favorites: [] } }) } });
  t.after(() => ui.unmount());
  assert.equal(ui.queryAll('.sb-item').length, 0);
  assert.ok(ui.query('.sb-tree'));
  assert.ok(visiblePane(ui));
});

test('watch registration failure preserves the listing and the refresh button retries automatic refresh', async (t) => {
  let watches = 0;
  let reads = 0;
  const ui = await mountPane({
    api: {
      readDir: async () => { reads += 1; return { ok: true, entries: [file('visible.txt')] }; },
      watchDir: async () => ++watches === 1 ? { ok: false, error: 'watch permission denied' } : { ok: true },
    },
  });
  t.after(() => ui.unmount());
  assert.deepEqual(displayedNames(ui), ['visible.txt']);
  assert.match(ui.query('.watch-status').textContent, /자동 새로고침 중지: watch permission denied/);
  await click(ui.query('[title="새로 고침"]'));
  assert.equal(watches, 2);
  assert.equal(reads, 2);
  assert.equal(ui.query('.watch-status'), null);
});

test('runtime watcher errors are shown and Command-R reconnects the watcher', async (t) => {
  let watches = 0;
  let reads = 0;
  const ui = await mountPane({
    api: {
      readDir: async () => { reads += 1; return { ok: true, entries: [file('visible.txt')] }; },
      watchDir: async () => { watches += 1; return { ok: true }; },
    },
  });
  t.after(() => ui.unmount());
  await ui.emitDirectory({ paneId: 'test-pane', dir: '/test', error: 'device disconnected' });
  assert.equal(reads, 1, 'an error event is not treated as a successful directory change');
  assert.match(ui.query('.watch-status').textContent, /device disconnected/);
  assert.deepEqual(displayedNames(ui), ['visible.txt']);
  await key(ui.query('.pane'), 'r', { metaKey: true });
  assert.equal(watches, 2);
  assert.equal(ui.query('.watch-status'), null);
  await ui.emitDirectory({ paneId: 'test-pane', dir: '/test' });
  assert.equal(reads, 3);
});

test('a late watcher response or error for the previous directory cannot replace current watch state', async (t) => {
  const oldWatch = deferred();
  const watched = [];
  const ui = await mountPane({
    api: {
      watchDir: (paneId, directory) => {
        watched.push(directory);
        return directory === '/test' ? oldWatch.promise : Promise.resolve({ ok: true });
      },
    },
  });
  t.after(() => ui.unmount());
  await click(ui.query('.bc-seg'));
  await flush(() => oldWatch.resolve({ ok: false, error: 'old watch failed' }));
  await ui.emitDirectory({ paneId: 'test-pane', dir: '/test', error: 'old directory disappeared' });
  assert.deepEqual(watched, ['/test', '/']);
  assert.equal(ui.query('.watch-status'), null);
});

test('a watcher error cannot be cleared by a late successful startup response', async (t) => {
  const startup = deferred();
  let watches = 0;
  const ui = await mountPane({ api: { watchDir: () => ++watches === 1 ? startup.promise : Promise.resolve({ ok: true }) } });
  t.after(() => ui.unmount());
  await ui.emitDirectory({ paneId: 'test-pane', dir: '/test', error: 'watch stopped immediately' });
  await flush(() => startup.resolve({ ok: true }));
  assert.match(ui.query('.watch-status').textContent, /watch stopped immediately/);
  await click(ui.query('.watch-status button'));
  assert.equal(watches, 2);
  assert.equal(ui.query('.watch-status'), null);
});

test('watch IPC rejection is recoverable and late failures after unmount are handled', async () => {
  const late = deferred();
  let watches = 0;
  const ui = await mountPane({
    api: { watchDir: () => ++watches === 1 ? Promise.reject(new Error('watch IPC unavailable')) : late.promise },
  });
  assert.match(ui.query('.watch-status').textContent, /watch IPC unavailable/);
  await click(ui.query('.watch-status button'));
  await ui.unmount();
  await flush(() => late.reject(new Error('late IPC failure')));
  assert.equal(ui.container.isConnected, false);
});

async function prepareBatch(ui) {
  await key(ui.query('.pane'), 'a', { metaKey: true });
  await flush(() => ui.query('.fl-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await click(ui.queryAll('.cm-item').find((node) => node.textContent === '일괄 이름 변경…'));
  await changeValue(ui.queryAll('.modal-fields input')[0], 'old');
  await changeValue(ui.queryAll('.modal-fields input')[1], 'new');
}

test('batch Cancel and mode buttons never submit on Enter or click', async (t) => {
  const applied = [];
  let canceled = 0;
  const ui = await mountComponent('src/components/BatchRenameDialog.jsx', { props: {
    entries: [file('old-a.txt'), file('old-b.txt')],
    onApply: (renames) => applied.push(renames), onCancel: () => { canceled++; },
  } });
  t.after(() => ui.unmount());
  await changeValue(ui.queryAll('.modal-fields input')[0], 'old');
  await changeValue(ui.queryAll('.modal-fields input')[1], 'new');
  const cancel = ui.query('.modal-actions button');
  assert.equal(cancel.type, 'button');
  await flush(() => cancel.focus());
  await key(cancel, 'Enter');
  // jsdom has no keyboard activation default; click exercises the browser button action.
  await click(cancel);
  assert.equal(canceled, 1);
  const mode = ui.queryAll('.modal-modes button')[1];
  assert.equal(mode.type, 'button');
  await key(mode, 'Enter');
  await click(mode);
  assert.deepEqual(applied, []);
  assert.ok(ui.query('input[type="number"]'));
});

test('batch submission is locked immediately and cannot be canceled or changed while pending', async (t) => {
  const pending = deferred();
  const applied = [];
  let canceled = 0;
  const ui = await mountComponent('src/components/BatchRenameDialog.jsx', { props: {
    entries: [file('old-a.txt'), file('old-b.txt')],
    onApply: (renames) => { applied.push(renames); return pending.promise; },
    onCancel: () => { canceled++; },
  } });
  t.after(() => ui.unmount());
  await changeValue(ui.queryAll('.modal-fields input')[0], 'old');
  await changeValue(ui.queryAll('.modal-fields input')[1], 'new');
  const form = ui.query('form');
  await flush(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(applied.length, 1);
  assert.equal(form.getAttribute('aria-busy'), 'true');
  assert(ui.queryAll('button, input').every((node) => node.disabled));
  await click(ui.query('.modal-actions button'));
  await key(form, 'Escape');
  await key(form, 'Enter');
  await key(form, 'Tab');
  await flush(() => ui.query('.modal-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  assert.equal(canceled, 0);
  assert.equal(document.activeElement, form, 'pending modal keeps keyboard focus away from background actions');
  assert.equal(applied.length, 1);
  await flush(() => pending.resolve());
  assert.equal(form.getAttribute('aria-busy'), 'false');
  await click(ui.query('.modal-actions button'));
  assert.equal(canceled, 1);
});

test('batch IME confirmation does not submit and normal submission resumes after composition', async (t) => {
  const applied = [];
  const ui = await mountComponent('src/components/BatchRenameDialog.jsx', { props: {
    entries: [file('old-a.txt')], onApply: (renames) => applied.push(renames), onCancel() {},
  } });
  t.after(() => ui.unmount());
  await changeValue(ui.queryAll('.modal-fields input')[0], 'old');
  const input = ui.queryAll('.modal-fields input')[1];
  await changeValue(input, '새 이름');
  await flush(() => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
  const enter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  await flush(() => input.dispatchEvent(enter));
  assert.equal(enter.defaultPrevented, true);
  await flush(() => ui.query('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(applied, []);
  await flush(() => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
  await click(ui.query('.primary'));
  assert.equal(applied.length, 1);
});

test('batch targets stay fixed when a directory refresh changes the live selection', async (t) => {
  let entries = [file('old-a.txt'), file('old-b.txt')];
  const renamed = [];
  const ui = await mountPane({ api: {
    readDir: async () => ({ ok: true, entries }),
    rename: async (from, name) => { renamed.push([from, name]); return { ok: true, path: `/test/${name}` }; },
  } });
  t.after(() => ui.unmount());
  await prepareBatch(ui);
  entries = [file('old-b.txt'), file('arrival.txt')];
  await ui.emitDirectory({ paneId: 'test-pane', dir: '/test' });
  assert.deepEqual(ui.queryAll('.mp-old').map((node) => node.textContent), ['old-a.txt', 'old-b.txt']);
  assert.match(ui.query('.modal-title').textContent, /2개 항목/);
  await click(ui.query('.primary'));
  assert.deepEqual(renamed, [['/test/old-a.txt', 'new-a.txt'], ['/test/old-b.txt', 'new-b.txt']]);
});

test('batch IPC rejection preserves the earlier successful undo tokens and unlocks the modal', async (t) => {
  const undone = [];
  let calls = 0;
  const ui = await mountApp({ entries: [file('old-a.txt'), file('old-b.txt')], api: {
    rename: async () => {
      if (++calls === 2) throw new Error('rename IPC disconnected');
      return { ok: true, path: '/test/new-a.txt', undo: [undoEntry('first-batch-item')] };
    },
    undo: async (token) => { undone.push(token); return { ok: true, dirs: ['/test'] }; },
  } });
  t.after(() => ui.unmount());
  await prepareBatch(ui);
  await click(ui.query('.primary'));
  assert.equal(ui.query('.modal'), null);
  assert.match(ui.alerts[0], /rename IPC disconnected/);
  await key(visiblePane(ui), 'z', { metaKey: true });
  assert.deepEqual(undone, ['first-batch-item']);
});

test('inline Enter followed by blur commits once and its late completion leaves a newer edit intact', async (t) => {
  const pending = deferred();
  const calls = [];
  const ui = await mountPane({ entries: [file('a.txt'), file('b.txt')], api: {
    rename: (from, name) => { calls.push([from, name]); return pending.promise; },
  } });
  t.after(() => ui.unmount());
  await click(ui.queryAll('.fl-row')[0]);
  await key(ui.query('.pane'), 'F2');
  const oldInput = ui.query('.rename-input');
  await changeValue(oldInput, 'renamed-a.txt');
  await flush(() => {
    oldInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    oldInput.blur();
  });
  assert.deepEqual(calls, [['/test/a.txt', 'renamed-a.txt']]);
  await click(ui.queryAll('.fl-row')[1]);
  await key(ui.query('.pane'), 'F2');
  await changeValue(ui.query('.rename-input'), 'renamed-b.txt');
  const newInput = ui.query('.rename-input');
  await flush(() => pending.resolve({ ok: true, path: '/test/renamed-a.txt', undo: [undoEntry('first-inline')] }));
  assert.equal(ui.query('.rename-input'), newInput);
  assert.equal(newInput.value, 'renamed-b.txt');
  await key(newInput, 'Escape');
  assert.equal(ui.query('.rename-input'), null);
  assert.equal(calls.length, 1);
});

test('inline rename ignores IME confirmation and reports an IPC rejection without leaving an editor stuck', async (t) => {
  let calls = 0;
  const ui = await mountPane({ entries: [file('old.txt')], api: {
    rename: async () => { calls++; throw new Error('rename IPC unavailable'); },
  } });
  t.after(() => ui.unmount());
  await click(ui.query('.fl-row'));
  await key(ui.query('.pane'), 'F2');
  const input = ui.query('.rename-input');
  await changeValue(input, '새 이름.txt');
  await key(input, 'Enter', { isComposing: true });
  await key(input, 'Escape', { isComposing: true });
  assert.equal(calls, 0);
  assert.equal(ui.query('.rename-input'), input);
  await key(input, 'Enter');
  assert.equal(calls, 1);
  assert.equal(ui.query('.rename-input'), null);
  assert.match(ui.alerts[0], /rename IPC unavailable/);
});

for (const cancellation of ['navigate away and back', 'Escape', 'blur', 'edit address', 'unmount']) {
  test(`late address lookup cannot navigate or alert after ${cancellation}`, async (t) => {
    const pending = deferred();
    const paths = [];
    const ui = await mountPane({ props: { onPathChange: (_id, value) => paths.push(value) }, api: {
      exists: () => pending.promise,
    } });
    t.after(() => ui.unmount());
    await key(ui.query('.pane'), 'l', { metaKey: true });
    const input = ui.query('.address-input');
    await changeValue(input, '/old-request');
    await key(input, 'Enter');
    if (cancellation === 'navigate away and back') {
      await click(ui.query('[title="상위 폴더"]'));
      await click(ui.query('[title="뒤로"]'));
    }
    if (cancellation === 'Escape') await key(input, 'Escape');
    if (cancellation === 'blur') await flush(() => input.blur());
    if (cancellation === 'edit address') await changeValue(input, '/current-input');
    if (cancellation === 'unmount') await ui.unmount();
    if (cancellation === 'unmount') await flush(() => pending.reject(new Error('late lookup failure')));
    else await flush(() => pending.resolve({ exists: cancellation !== 'Escape', isDir: true }));
    assert.equal(paths.at(-1), '/test');
    assert.deepEqual(ui.alerts, []);
    if (cancellation === 'edit address') assert.equal(ui.query('.address-input').value, '/current-input');
  });
}

test('the newest address submission wins and current lookup errors remain visible', async (t) => {
  const first = deferred();
  const calls = [];
  const ui = await mountPane({ api: {
    exists: (value) => {
      calls.push(value);
      if (value === '/old') return first.promise;
      if (value === '/failure') return Promise.reject(new Error('address IPC unavailable'));
      return Promise.resolve({ exists: true, isDir: true });
    },
  } });
  t.after(() => ui.unmount());
  await key(ui.query('.pane'), 'l', { metaKey: true });
  await changeValue(ui.query('.address-input'), '/old');
  await key(ui.query('.address-input'), 'Enter');
  await changeValue(ui.query('.address-input'), '~/current');
  await key(ui.query('.address-input'), 'Enter', { isComposing: true });
  assert.deepEqual(calls, ['/old']);
  await key(ui.query('.address-input'), 'Enter');
  await flush(() => first.resolve({ exists: true, isDir: true }));
  assert.deepEqual(calls, ['/old', '/test/current']);
  assert.equal(ui.query('.bc-seg:last-child').textContent, 'current');
  await key(ui.query('.pane'), 'l', { metaKey: true });
  await changeValue(ui.query('.address-input'), '/failure');
  await key(ui.query('.address-input'), 'Enter');
  assert.match(ui.alerts[0], /address IPC unavailable/);
  assert.equal(ui.query('.address-input').value, '/failure');
});

async function emitChanges(dirs) {
  await flush(() => window.dispatchEvent(new CustomEvent('mx-fs-changed', { detail: { dirs } })));
}

async function advanceRefresh(t, milliseconds = 100) {
  await flush(() => t.mock.timers.tick(milliseconds));
}

for (const spotlight of [false, true]) {
  test(`manual refresh immediately reruns the active ${spotlight ? 'Spotlight' : 'recursive'} query while preserving its rows and selection`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = deferred();
    const calls = [];
    const search = (...args) => {
      calls.push(args);
      return calls.length === 1 ? Promise.resolve({ ok: true, entries: [file('old-result.txt')] }) : pending.promise;
    };
    const ui = await mountPane({ props: { showHidden: true }, api: { search, searchSpotlight: search } });
    t.after(() => ui.unmount());
    await searchFor(ui, 'result', spotlight);
    await click(ui.query('.fl-row'));
    await click(ui.query('[title="새로 고침"]'));
    assert.deepEqual(calls, [
      ['/test', 'result', { showHidden: true }], ['/test', 'result', { showHidden: true }],
    ]);
    assert.deepEqual(displayedNames(ui), ['old-result.txt']);
    assert.match(ui.query('.statusbar').textContent, /1개 선택됨/);
    assert.match(ui.query('.search-banner').textContent, /검색 중/);
    await flush(() => pending.resolve({ ok: true, entries: [file('new-result.txt')] }));
    assert.deepEqual(displayedNames(ui), ['new-result.txt']);
    assert.equal(ui.query('.search-banner').textContent.includes('Spotlight'), spotlight);
  });
}

test('watcher and operation notifications coalesce related search changes without overlapping automatic searches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstRefresh = deferred();
  const secondRefresh = deferred();
  let calls = 0;
  const ui = await mountPane({ props: { initialPath: '/test/sub' }, api: {
    search: () => {
      calls++;
      if (calls === 1) return Promise.resolve({ ok: true, entries: [file('original.txt')] });
      return calls === 2 ? firstRefresh.promise : secondRefresh.promise;
    },
  } });
  t.after(() => ui.unmount());
  await searchFor(ui, 'result');
  await emitChanges(['/test/submarine', '/elsewhere']);
  await ui.emitDirectory({ paneId: 'another-pane', dir: '/unrelated' });
  await advanceRefresh(t);
  assert.equal(calls, 1, 'shared prefixes and unrelated directories do not refresh this search');
  await emitChanges(['/test']);
  await emitChanges(['/test/sub/deep']);
  await ui.emitDirectory({ paneId: 'another-pane', dir: '/test/sub' });
  await advanceRefresh(t, 99);
  assert.equal(calls, 1);
  await advanceRefresh(t, 1);
  assert.equal(calls, 2, 'one search handles the burst from both notification sources');
  await ui.emitDirectory({ paneId: 'test-pane', dir: '/test/sub' });
  await emitChanges(['/']);
  await advanceRefresh(t);
  assert.equal(calls, 2, 'an automatic refresh waits for the already running search');
  await flush(() => firstRefresh.resolve({ ok: true, entries: [file('stale-refresh.txt')] }));
  assert.equal(calls, 3);
  assert.deepEqual(displayedNames(ui), ['original.txt'], 'the invalidated response cannot replace retained results');
  await flush(() => secondRefresh.resolve({ ok: true, entries: [file('current-refresh.txt')] }));
  assert.deepEqual(displayedNames(ui), ['current-refresh.txt']);
});

test('a search rooted at slash refreshes after a descendant change', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const ui = await mountPane({ props: { initialPath: '/' }, api: {
    searchSpotlight: async (...args) => { calls.push(args); return { ok: true, entries: [] }; },
  } });
  t.after(() => ui.unmount());
  await searchFor(ui, 'volume', true);
  await emitChanges(['/Volumes/External/folder']);
  await advanceRefresh(t);
  assert.deepEqual(calls, [['/', 'volume', { showHidden: false }], ['/', 'volume', { showHidden: false }]]);
});

test('manual refresh supersedes a queued automatic refresh and its late response stays canceled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  let calls = 0;
  const ui = await mountPane({ entries: [file('base.txt')], api: {
    search: () => ++calls === 1 ? Promise.resolve({ ok: true, entries: [file('old-result.txt')] }) : pending.promise,
  } });
  t.after(() => ui.unmount());
  await searchFor(ui, 'result');
  await emitChanges(['/test/child']);
  await advanceRefresh(t, 50);
  await key(ui.query('.pane'), 'r', { metaKey: true });
  assert.equal(calls, 2);
  await advanceRefresh(t);
  assert.equal(calls, 2);
  await click(ui.query('.search-banner button'));
  await flush(() => pending.resolve({ ok: true, entries: [file('late-result.txt')] }));
  assert.equal(ui.query('.search-banner'), null);
  assert.deepEqual(displayedNames(ui), ['base.txt']);
});

for (const cancellation of ['close search', 'edit query', 'navigate', 'unmount']) {
  test(`a queued search refresh cannot restart after ${cancellation}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const ui = await mountPane({ api: {
      search: async () => { calls++; return { ok: true, entries: [file('result.txt')] }; },
    } });
    t.after(() => ui.unmount());
    await searchFor(ui, 'result');
    await emitChanges(['/test']);
    if (cancellation === 'close search') await click(ui.query('.search-banner button'));
    if (cancellation === 'edit query') await changeValue(ui.query('.search-input'), 'new query');
    if (cancellation === 'navigate') await click(ui.query('[title="상위 폴더"]'));
    if (cancellation === 'unmount') await ui.unmount();
    await advanceRefresh(t);
    assert.equal(calls, 1);
    assert.equal(ui.query('.search-banner'), null);
  });
}

test('deleting and renaming nested search results refreshes the active search from successful file changes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let matches = [file('match.txt', { path: '/test/nested/match.txt' })];
  const calls = [];
  const ui = await mountPane({ api: {
    search: async (...args) => { calls.push(args); return { ok: true, entries: matches }; },
    rename: async (_from, name) => {
      matches = [file(name, { path: `/test/nested/${name}` })];
      return { ok: true, path: matches[0].path, undo: [undoEntry('nested-rename', matches[0].path)] };
    },
    trash: async (paths) => { matches = []; return { ok: true, trashed: paths }; },
  } });
  t.after(() => ui.unmount());
  await searchFor(ui, 'match');
  await click(ui.query('.fl-row'));
  await key(ui.query('.pane'), 'F2');
  await changeValue(ui.query('.rename-input'), 'match-renamed.txt');
  await key(ui.query('.rename-input'), 'Enter');
  await advanceRefresh(t);
  assert.deepEqual(displayedNames(ui), ['match-renamed.txt']);
  await click(ui.query('.fl-row'));
  await key(ui.query('.pane'), 'Delete');
  await advanceRefresh(t);
  assert.deepEqual(displayedNames(ui), []);
  assert.equal(calls.length, 3);
  assert.match(ui.query('.search-banner').textContent, /검색 결과 0개/);
});

test('creating a file refreshes another pane displaying the same folder', async (t) => {
  let entries = [];
  const ui = await mountApp({ api: {
    readDir: async () => ({ ok: true, entries }),
    newFile: async () => {
      entries = [file('created.txt')];
      return { ok: true, path: '/test/created.txt', undo: [undoEntry('created', '/test/created.txt')] };
    },
  } });
  t.after(() => ui.unmount());
  await click(ui.query('[title="듀얼 패널 (⇧⌘D)"]'));
  const [first, second] = ui.queryAll('.pane');
  await flush(() => first.querySelector('.filelist').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await click(ui.queryAll('.cm-item').find((node) => node.textContent === '새 파일'));
  assert.equal(first.querySelectorAll('.fl-row').length, 1);
  assert.equal(second.querySelector('.fl-name').textContent, 'created.txt');
});
