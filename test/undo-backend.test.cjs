const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { loadMain } = require('./helpers/main.cjs');

async function fixture(t, { beforeTrash } = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-undo-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const trashed = [];
  const api = loadMain({
    userData: root,
    shell: {
      async trashItem(file) {
        trashed.push(file);
        if (beforeTrash) await beforeTrash(file);
        await fsp.rm(file, { recursive: true });
      },
    },
  });
  return { root, api, trashed };
}

function tokenOf(result, file = result.path) {
  assert.equal(result.ok, true, result.error);
  assert.ok(Array.isArray(result.undo), 'mutation returns undo records');
  const entry = result.undo.find((item) => item.path === file);
  assert.ok(entry, `undo record is present for ${file}`);
  assert.equal(typeof entry.token, 'string');
  assert.ok(entry.token.length > 0);
  return entry.token;
}

function assertRejected(result) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
}

function assertUndone(result, expectedDirs) {
  assert.equal(result.ok, true, result.error);
  assert.ok(Array.isArray(result.dirs), 'undo identifies directories to refresh');
  for (const dir of expectedDirs) assert.ok(result.dirs.includes(dir), `refreshes ${dir}`);
}

async function assertMissing(file) {
  await assert.rejects(fsp.lstat(file), { code: 'ENOENT' });
}

async function pendingRequestResult(request) {
  let timer;
  try {
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('request waited for the active undo instead of responding')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function otherSender(api, id = 2) {
  const frame = { url: api.event.senderFrame.url };
  const sender = Object.assign(new EventEmitter(), {
    id,
    mainFrame: frame,
    isDestroyed: () => false,
    send() {},
  });
  const event = { sender, senderFrame: frame };
  return (channel, ...args) => api.handlers.get(channel)(event, ...args);
}

for (const [channel, name] of [['fs:newFile', 'file.txt'], ['fs:mkdir', 'folder']]) {
  test(`${channel} issues a one-shot undo token that trashes its unchanged result`, async (t) => {
    const { root, api, trashed } = await fixture(t);
    const created = await api.invoke(channel, root, name);
    const token = tokenOf(created);

    assertUndone(await api.invoke('fs:undo', token), [root]);
    await assertMissing(created.path);
    assert.deepEqual(trashed, [created.path]);
    assertRejected(await api.invoke('fs:undo', token));
    assert.deepEqual(trashed, [created.path]);
  });
}

test('undoing a rename restores the earlier create token for the same unchanged file', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const created = await api.invoke('fs:newFile', root, 'original.txt');
  const createToken = tokenOf(created);
  const renamed = await api.invoke('fs:rename', created.path, 'renamed.txt');
  const renameToken = tokenOf(renamed);
  assert.notEqual(renameToken, createToken);
  await assertMissing(created.path);
  assertRejected(await api.invoke('fs:undo', createToken));
  assert.equal(await fsp.readFile(renamed.path, 'utf8'), '');
  assert.deepEqual(trashed, [], 'an older receipt cannot delete the current revision');

  assertUndone(await api.invoke('fs:undo', renameToken), [root]);
  assert.equal(await fsp.readFile(created.path, 'utf8'), '');
  await assertMissing(renamed.path);
  assert.deepEqual(trashed, []);
  assertUndone(await api.invoke('fs:undo', createToken), [root]);
  await assertMissing(created.path);
  assert.deepEqual(trashed, [created.path]);
});

test('undoing a created child makes its original parent-folder creation undo usable', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const folder = await api.invoke('fs:mkdir', root, 'folder');
  const folderToken = tokenOf(folder);
  const child = await api.invoke('fs:newFile', folder.path, 'child');
  const childToken = tokenOf(child);

  assertRejected(await api.invoke('fs:undo', folderToken));
  assert.deepEqual(trashed, []);
  assertUndone(await api.invoke('fs:undo', childToken), [folder.path]);
  assert.deepEqual(await fsp.readdir(folder.path), []);
  assertUndone(await api.invoke('fs:undo', folderToken), [root]);
  await assertMissing(folder.path);
  assert.deepEqual(trashed, [child.path, folder.path]);
});

test('undoing several renames in reverse order keeps the original create undo valid', async (t) => {
  const { root, api } = await fixture(t);
  const created = await api.invoke('fs:newFile', root, 'first');
  const tokens = [tokenOf(created)];
  let current = created.path;
  const destinations = [];
  for (const name of ['second', 'third', 'fourth']) {
    const result = await api.invoke('fs:rename', current, name);
    tokens.push(tokenOf(result));
    destinations.push(result.path);
    current = result.path;
  }

  for (let index = tokens.length - 1; index > 0; index--) {
    assertUndone(await api.invoke('fs:undo', tokens[index]), [root]);
    await assertMissing(destinations[index - 1]);
  }
  assert.equal(await fsp.readFile(created.path, 'utf8'), '');
  assertUndone(await api.invoke('fs:undo', tokens[0]), [root]);
  await assertMissing(created.path);
});

test('copy undo removes only the copied result and keeps the original', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination');
  await fsp.writeFile(source, 'source contents');
  await fsp.mkdir(destination);
  const result = await api.invoke('fs:copy', [source], destination);
  assert.deepEqual(result.created, [path.join(destination, 'source.txt')]);
  const token = tokenOf(result, result.created[0]);

  assertUndone(await api.invoke('fs:undo', token), [destination]);
  await assertMissing(result.created[0]);
  assert.equal(await fsp.readFile(source, 'utf8'), 'source contents');
  assert.deepEqual(trashed, result.created);
});

test('move undo restores the source path and reports both changed directories', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const sourceDir = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fsp.mkdir(sourceDir);
  await fsp.mkdir(destination);
  const source = path.join(sourceDir, 'file');
  await fsp.writeFile(source, 'contents');
  const result = await api.invoke('fs:move', [source], destination);
  const moved = path.join(destination, 'file');
  assert.deepEqual(result.items, [{ from: source, to: moved }]);
  const token = tokenOf(result, moved);

  assertUndone(await api.invoke('fs:undo', token), [sourceDir, destination]);
  assert.equal(await fsp.readFile(source, 'utf8'), 'contents');
  await assertMissing(moved);
  assert.deepEqual(trashed, []);
});

test('create undo refuses a different file subsequently placed at the same path', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const created = await api.invoke('fs:newFile', root, 'file');
  const token = tokenOf(created);
  const original = path.join(root, 'original-kept');
  await fsp.rename(created.path, original);
  await fsp.writeFile(created.path, 'replacement contents');

  assertRejected(await api.invoke('fs:undo', token));
  assert.equal(await fsp.readFile(created.path, 'utf8'), 'replacement contents');
  assert.equal(await fsp.readFile(original, 'utf8'), '');
  assert.deepEqual(trashed, []);
});

test('create undo refuses a file whose contents changed externally', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const created = await api.invoke('fs:newFile', root, 'file');
  const token = tokenOf(created);
  await fsp.writeFile(created.path, 'external edit');

  assertRejected(await api.invoke('fs:undo', token));
  assert.equal(await fsp.readFile(created.path, 'utf8'), 'external edit');
  assert.deepEqual(trashed, []);
});

test('folder create undo refuses to trash newly added descendants', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const created = await api.invoke('fs:mkdir', root, 'folder');
  const token = tokenOf(created);
  const child = path.join(created.path, 'new-file');
  await fsp.writeFile(child, 'new child contents');

  assertRejected(await api.invoke('fs:undo', token));
  assert.equal(await fsp.readFile(child, 'utf8'), 'new child contents');
  assert.deepEqual(trashed, []);
});

test('copy undo notices a deep child edit even though the copied root directory is unchanged', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fsp.mkdir(path.join(source, 'nested'), { recursive: true });
  await fsp.mkdir(destination);
  await fsp.writeFile(path.join(source, 'nested', 'file'), 'original');
  const copied = await api.invoke('fs:copy', [source], destination);
  const resultPath = copied.created[0];
  const token = tokenOf(copied, resultPath);
  const child = path.join(resultPath, 'nested', 'file');
  await fsp.writeFile(child, 'external edit');

  assertRejected(await api.invoke('fs:undo', token));
  assert.equal(await fsp.readFile(child, 'utf8'), 'external edit');
  assert.equal(await fsp.readFile(path.join(source, 'nested', 'file'), 'utf8'), 'original');
  assert.deepEqual(trashed, []);
});

test('renaming an externally edited created file does not make its stale create undo valid', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const created = await api.invoke('fs:newFile', root, 'original');
  const createToken = tokenOf(created);
  await fsp.writeFile(created.path, 'external edit before rename');
  const renamed = await api.invoke('fs:rename', created.path, 'renamed');
  const renameToken = tokenOf(renamed);

  assertUndone(await api.invoke('fs:undo', renameToken), [root]);
  assert.equal(await fsp.readFile(created.path, 'utf8'), 'external edit before rename');
  assertRejected(await api.invoke('fs:undo', createToken));
  assert.equal(await fsp.readFile(created.path, 'utf8'), 'external edit before rename');
  assert.deepEqual(trashed, []);
});

test('rename undo refuses an external edit made after the rename', async (t) => {
  const { root, api } = await fixture(t);
  const source = path.join(root, 'original');
  await fsp.writeFile(source, 'original contents');
  const renamed = await api.invoke('fs:rename', source, 'renamed');
  const token = tokenOf(renamed);
  await fsp.writeFile(renamed.path, 'external edit after rename');

  assertRejected(await api.invoke('fs:undo', token));
  assert.equal(await fsp.readFile(renamed.path, 'utf8'), 'external edit after rename');
  await assertMissing(source);
});

test('rename undo resolves a symlinked parent directory to the same original entry', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  await fsp.mkdir(actual);
  await fsp.symlink(actual, alias);
  const source = path.join(actual, 'original');
  await fsp.writeFile(source, 'contents');
  const renamed = await api.invoke('fs:rename', path.join(alias, 'original'), 'renamed');
  const token = tokenOf(renamed);

  const undone = await api.invoke('fs:undo', token);
  assert.equal(undone.ok, true, undone.error);
  assert.ok(Array.isArray(undone.dirs));
  assert.ok(undone.dirs.some((dir) => dir === actual || dir === alias));
  assert.equal(await fsp.readFile(source, 'utf8'), 'contents');
  assert.equal(await fsp.readFile(path.join(alias, 'original'), 'utf8'), 'contents');
  await assertMissing(path.join(actual, 'renamed'));
  assert.deepEqual(trashed, []);
});

test('rename undo preserves an occupied original name and keeps its token for retry', async (t) => {
  const { root, api } = await fixture(t);
  const source = path.join(root, 'original');
  await fsp.writeFile(source, 'original contents');
  const renamed = await api.invoke('fs:rename', source, 'renamed');
  const token = tokenOf(renamed);
  await fsp.writeFile(source, 'name occupied externally');

  assertRejected(await api.invoke('fs:undo', token));
  assert.equal(await fsp.readFile(source, 'utf8'), 'name occupied externally');
  assert.equal(await fsp.readFile(renamed.path, 'utf8'), 'original contents');
  await fsp.unlink(source);
  assertUndone(await api.invoke('fs:undo', token), [root]);
  assert.equal(await fsp.readFile(source, 'utf8'), 'original contents');
  await assertMissing(renamed.path);
  assertRejected(await api.invoke('fs:undo', token));
});

test('a failed trash operation keeps the same undo token available for retry', async (t) => {
  let failTrash = true;
  const { root, api, trashed } = await fixture(t, {
    beforeTrash() { if (failTrash) throw new Error('injected trash failure'); },
  });
  const created = await api.invoke('fs:newFile', root, 'file');
  const token = tokenOf(created);

  assertRejected(await api.invoke('fs:undo', token));
  assert.equal(await fsp.readFile(created.path, 'utf8'), '');
  failTrash = false;
  assertUndone(await api.invoke('fs:undo', token), [root]);
  await assertMissing(created.path);
  assert.deepEqual(trashed, [created.path, created.path]);
});

test('another trusted renderer cannot use the owning renderer undo token', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const created = await api.invoke('fs:newFile', root, 'file');
  const token = tokenOf(created);
  const invokeOther = otherSender(api);

  assertRejected(await invokeOther('fs:undo', token));
  assert.equal(await fsp.readFile(created.path, 'utf8'), '');
  assert.deepEqual(trashed, []);
  assertUndone(await api.invoke('fs:undo', token), [root]);
  await assertMissing(created.path);
});

test('an unknown undo token is rejected without modifying files', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const existing = path.join(root, 'existing');
  await fsp.writeFile(existing, 'contents');

  assertRejected(await api.invoke('fs:undo', 'unknown-undo-token'));
  assert.equal(await fsp.readFile(existing, 'utf8'), 'contents');
  assert.deepEqual(trashed, []);
});

test('releasing a token prevents future undo without modifying the item', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const created = await api.invoke('fs:newFile', root, 'file');
  const token = tokenOf(created);

  const released = await api.invoke('fs:undoRelease', [token]);
  assert.equal(released.ok, true, released.error);
  assertRejected(await api.invoke('fs:undo', token));
  assert.equal(await fsp.readFile(created.path, 'utf8'), '');
  assert.deepEqual(trashed, []);
});

test('another trusted renderer cannot release the owning renderer undo token', async (t) => {
  const { root, api, trashed } = await fixture(t);
  const created = await api.invoke('fs:newFile', root, 'file');
  const token = tokenOf(created);
  const invokeOther = otherSender(api);

  assertRejected(await invokeOther('fs:undoRelease', [token]));
  assert.equal(await fsp.readFile(created.path, 'utf8'), '');
  assert.deepEqual(trashed, []);
  assertUndone(await api.invoke('fs:undo', token), [root]);
  await assertMissing(created.path);
});

test('simultaneous undo requests consume a token only once', async (t) => {
  let releaseTrash;
  const gate = new Promise((resolve) => { releaseTrash = resolve; });
  let trashStarted;
  const started = new Promise((resolve) => { trashStarted = resolve; });
  let calls = 0;
  const { root, api, trashed } = await fixture(t, {
    async beforeTrash() {
      calls++;
      if (calls === 1) {
        trashStarted();
        await gate;
      }
    },
  });
  const created = await api.invoke('fs:newFile', root, 'file');
  const token = tokenOf(created);
  const first = api.invoke('fs:undo', token);
  assert.equal(await Promise.race([started.then(() => true), first.then(() => false)]), true,
    'first undo reaches the deferred trash operation');
  try {
    assertRejected(await pendingRequestResult(api.invoke('fs:undo', token)));
    assert.deepEqual(trashed, [created.path]);
    assert.equal(await fsp.readFile(created.path, 'utf8'), '');
  } finally {
    releaseTrash();
  }

  assertUndone(await first, [root]);
  await assertMissing(created.path);
  assertRejected(await api.invoke('fs:undo', token));
  assert.deepEqual(trashed, [created.path]);
});

test('releasing an active undo token lets its operation finish without making the token reusable', async (t) => {
  let releaseTrash;
  const gate = new Promise((resolve) => { releaseTrash = resolve; });
  let trashStarted;
  const started = new Promise((resolve) => { trashStarted = resolve; });
  let calls = 0;
  const { root, api, trashed } = await fixture(t, {
    async beforeTrash() {
      calls++;
      if (calls === 1) {
        trashStarted();
        await gate;
      }
    },
  });
  const created = await api.invoke('fs:newFile', root, 'file');
  const token = tokenOf(created);
  const active = api.invoke('fs:undo', token);
  assert.equal(await Promise.race([started.then(() => true), active.then(() => false)]), true,
    'active undo reaches the deferred trash operation');
  try {
    const released = await pendingRequestResult(api.invoke('fs:undoRelease', [token]));
    assert.equal(released.ok, true, released.error);
    assertRejected(await pendingRequestResult(api.invoke('fs:undo', token)));
    assert.deepEqual(trashed, [created.path]);
  } finally {
    releaseTrash();
  }

  assertUndone(await active, [root]);
  await assertMissing(created.path);
  assertRejected(await api.invoke('fs:undo', token));
  assert.deepEqual(trashed, [created.path]);
});
