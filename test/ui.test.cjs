const test = require('node:test');
const assert = require('node:assert/strict');
const { mountPane, file, click, key, changeValue } = require('./helpers/ui.cjs');

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
