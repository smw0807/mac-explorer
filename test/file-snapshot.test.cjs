const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const snapshotPath = path.resolve(__dirname, '../electron/file-snapshot.cjs');
const snapshots = require(snapshotPath);

function loadSnapshots(overrides = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(snapshotPath, 'utf8');
  const evaluate = vm.runInThisContext(`(function (require, module, exports) {\n${source}\n})`, {
    filename: snapshotPath,
  });
  evaluate((name) => {
    if (name === 'fs/promises' || name === 'node:fs/promises') return { ...fsp, ...overrides };
    return require(name);
  }, module, module.exports);
  return module.exports;
}

async function fixture(t) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-snapshot-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function changed(error) {
  assert.equal(error.code, 'FS_CHANGED');
  assert.equal(typeof error.changedPath, 'string');
  return true;
}

async function assertMissing(file) {
  await assert.rejects(fsp.lstat(file), { code: 'ENOENT' });
}

test('captures a serializable tree without following valid, broken, or cyclic symlinks', async (t) => {
  const root = await fixture(t);
  await fsp.mkdir(path.join(root, 'nested'));
  await fsp.writeFile(path.join(root, 'nested', 'file'), 'contents');
  await fsp.symlink('nested/file', path.join(root, 'link'));
  await fsp.symlink('missing', path.join(root, 'broken'));
  await fsp.symlink('.', path.join(root, 'cycle'));

  const snapshot = await snapshots.captureSnapshot(root);
  assert.equal(snapshot.version, 1);
  assert.deepEqual(Object.keys(snapshot.entries).sort(), ['', 'broken', 'cycle', 'link', 'nested', 'nested/file']);
  assert.equal(snapshot.entries[''].type, 'directory');
  assert.deepEqual(snapshot.entries[''].children, ['broken', 'cycle', 'link', 'nested']);
  assert.deepEqual(snapshot.entries.nested.children, ['file']);
  assert.equal(snapshot.entries['nested/file'].type, 'file');
  assert.equal(snapshot.entries.link.type, 'symlink');
  assert.equal(snapshot.entries.link.target, 'nested/file');
  assert.equal(snapshot.entries.broken.target, 'missing');
  assert.equal(snapshot.entries.cycle.target, '.');
  for (const entry of Object.values(snapshot.entries)) {
    for (const key of ['dev', 'ino', 'mode', 'size', 'nlink', 'birthtimeNs', 'mtimeNs', 'ctimeNs']) {
      assert.match(entry[key], /^\d+$/, `${key} must survive JSON serialization without precision loss`);
    }
    assert.equal(Object.keys(entry).some((key) => key.startsWith('atime')), false);
  }
  await snapshots.assertSnapshot(root, JSON.parse(JSON.stringify(snapshot)));
});

test('captures and removes filenames that match object prototype properties', async (t) => {
  const root = await fixture(t);
  const tree = path.join(root, 'tree');
  await fsp.mkdir(tree);
  for (const name of ['__proto__', 'constructor', 'toString']) {
    await fsp.writeFile(path.join(tree, name), name);
  }
  const snapshot = await snapshots.captureSnapshot(tree);
  const restored = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(Object.keys(restored.entries).sort(), ['', '__proto__', 'constructor', 'toString']);

  await snapshots.assertSnapshot(tree, restored);
  await snapshots.removeVerifiedSnapshot(tree, restored);
  await assertMissing(tree);
});

test('detects a same-size file edit after its original mtime is restored', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  const timestamp = new Date('2020-01-02T03:04:05.000Z');
  await fsp.writeFile(file, 'original');
  await fsp.utimes(file, timestamp, timestamp);
  const snapshot = await snapshots.captureSnapshot(file);
  await fsp.writeFile(file, 'modified');
  await fsp.utimes(file, timestamp, timestamp);
  assert.equal((await fsp.lstat(file, { bigint: true })).mtimeNs.toString(), snapshot.entries[''].mtimeNs);

  await assert.rejects(snapshots.assertSnapshot(file, snapshot), changed);
  assert.equal(await fsp.readFile(file, 'utf8'), 'modified');
});

test('detects a deep child edit when the root directory metadata is unchanged', async (t) => {
  const root = await fixture(t);
  const nested = path.join(root, 'nested');
  const file = path.join(nested, 'file');
  await fsp.mkdir(nested);
  await fsp.writeFile(file, 'original');
  const snapshot = await snapshots.captureSnapshot(root);
  await fsp.writeFile(file, 'modified');
  const rootStat = await fsp.lstat(root, { bigint: true });
  assert.equal(rootStat.mtimeNs.toString(), snapshot.entries[''].mtimeNs);
  assert.equal(rootStat.ctimeNs.toString(), snapshot.entries[''].ctimeNs);

  await assert.rejects(snapshots.assertSnapshot(root, snapshot), changed);
});

test('detects a replaced file even when its contents and mtime match', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  const replacement = path.join(root, 'replacement');
  const timestamp = new Date('2020-01-02T03:04:05.000Z');
  await fsp.writeFile(file, 'same contents');
  await fsp.utimes(file, timestamp, timestamp);
  const snapshot = await snapshots.captureSnapshot(file);
  await fsp.writeFile(replacement, 'same contents');
  await fsp.utimes(replacement, timestamp, timestamp);
  await fsp.rename(replacement, file);

  await assert.rejects(snapshots.assertSnapshot(file, snapshot), changed);
});

test('detects a changed symlink target without reading either target', async (t) => {
  const root = await fixture(t);
  const link = path.join(root, 'link');
  await fsp.symlink('missing-a', link);
  const snapshot = await snapshots.captureSnapshot(link);
  await fsp.unlink(link);
  await fsp.symlink('missing-b', link);

  await assert.rejects(snapshots.assertSnapshot(link, snapshot), changed);
  assert.equal(await fsp.readlink(link), 'missing-b');
});

test('reports a missing snapshot entry as a filesystem change', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fsp.writeFile(file, 'contents');
  const snapshot = await snapshots.captureSnapshot(file);
  await fsp.unlink(file);

  await assert.rejects(snapshots.assertSnapshot(file, snapshot), changed);
});

test('ignores access-time changes without ignoring other file metadata', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fsp.writeFile(file, 'contents');
  const snapshot = await snapshots.captureSnapshot(file);
  const isolated = loadSnapshots({
    async lstat(...args) {
      const stat = await fsp.lstat(...args);
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        atime: new Date('2030-01-01T00:00:00.000Z'),
        atimeMs: typeof stat.atimeMs === 'bigint' ? 1893456000000n : 1893456000000,
        atimeNs: 1893456000000000000n,
      });
    },
  });

  await isolated.assertSnapshot(file, snapshot);
});

for (const type of ['file', 'directory', 'symlink']) {
  test(`accepts a renamed ${type} root only when root-rename handling is enabled`, async (t) => {
    const root = await fixture(t);
    const source = path.join(root, 'source');
    const renamed = path.join(root, 'renamed');
    if (type === 'directory') {
      await fsp.mkdir(source);
      await fsp.writeFile(path.join(source, 'child'), 'contents');
    } else if (type === 'symlink') {
      await fsp.symlink('missing', source);
    } else {
      await fsp.writeFile(source, 'contents');
    }
    const snapshot = await snapshots.captureSnapshot(source);
    await fsp.rename(source, renamed);

    await snapshots.assertSnapshot(renamed, snapshot, { allowRootRename: true });
    const renamedStat = await fsp.lstat(renamed, { bigint: true });
    if (renamedStat.ctimeNs.toString() !== snapshot.entries[''].ctimeNs) {
      await assert.rejects(snapshots.assertSnapshot(renamed, snapshot), changed);
    }
  });
}

test('root-rename handling does not hide a changed root file or a changed child', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fsp.writeFile(file, 'original');
  const fileSnapshot = await snapshots.captureSnapshot(file);
  const treeSnapshot = await snapshots.captureSnapshot(root);
  await fsp.writeFile(file, 'changed and longer');

  await assert.rejects(snapshots.assertSnapshot(file, fileSnapshot, { allowRootRename: true }), changed);
  await assert.rejects(snapshots.assertSnapshot(root, treeSnapshot, { allowRootRename: true }), changed);
});

test('rejects a directory that changes while its children are being captured', async (t) => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root, 'original'), 'contents');
  let injected = false;
  const isolated = loadSnapshots({
    async readdir(dir, ...args) {
      const names = await fsp.readdir(dir, ...args);
      if (dir === root && !injected) {
        injected = true;
        await fsp.writeFile(path.join(root, 'new'), 'new contents');
      }
      return names;
    },
  });

  await assert.rejects(isolated.captureSnapshot(root), changed);
  assert.equal(injected, true);
  assert.equal(await fsp.readFile(path.join(root, 'new'), 'utf8'), 'new contents');
});

test('removes an unchanged tree, including hardlinks and broken links, without following symlinks', async (t) => {
  const root = await fixture(t);
  const tree = path.join(root, 'tree');
  const external = path.join(root, 'external');
  await fsp.mkdir(path.join(tree, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(tree, 'original'), 'shared contents');
  await fsp.link(path.join(tree, 'original'), path.join(tree, 'nested', 'hardlink'));
  await fsp.link(path.join(tree, 'original'), external);
  await fsp.symlink('../external', path.join(tree, 'link'));
  await fsp.symlink('missing', path.join(tree, 'broken'));
  const snapshot = await snapshots.captureSnapshot(tree);

  await snapshots.removeVerifiedSnapshot(tree, snapshot);
  await assertMissing(tree);
  assert.equal(await fsp.readFile(external, 'utf8'), 'shared contents');
  assert.equal((await fsp.lstat(external)).nlink, 1);
});

test('does not delete a file changed after its snapshot was captured', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fsp.writeFile(file, 'original');
  const snapshot = await snapshots.captureSnapshot(file);
  await fsp.writeFile(file, 'new contents');

  await assert.rejects(snapshots.removeVerifiedSnapshot(file, snapshot), changed);
  assert.equal(await fsp.readFile(file, 'utf8'), 'new contents');
});

test('preserves a new child discovered before verified deletion starts', async (t) => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root, 'original'), 'original contents');
  const snapshot = await snapshots.captureSnapshot(root);
  await fsp.writeFile(path.join(root, 'new'), 'new contents');

  await assert.rejects(snapshots.removeVerifiedSnapshot(root, snapshot), changed);
  assert.equal(await fsp.readFile(path.join(root, 'new'), 'utf8'), 'new contents');
});

test('stops verified deletion if a later file changes after an earlier file is removed', async (t) => {
  const root = await fixture(t);
  const first = path.join(root, 'a');
  const later = path.join(root, 'b');
  await fsp.writeFile(first, 'first contents');
  await fsp.writeFile(later, 'original contents');
  const snapshot = await snapshots.captureSnapshot(root);
  let injected = false;
  const isolated = loadSnapshots({
    async unlink(file) {
      await fsp.unlink(file);
      if (file === first) {
        injected = true;
        await fsp.writeFile(later, 'changed during deletion');
      }
    },
  });

  await assert.rejects(isolated.removeVerifiedSnapshot(root, snapshot), changed);
  assert.equal(injected, true);
  await assertMissing(first);
  assert.equal(await fsp.readFile(later, 'utf8'), 'changed during deletion');
});

test('never recursively deletes a child created immediately before rmdir', async (t) => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root, 'original'), 'original contents');
  const snapshot = await snapshots.captureSnapshot(root);
  let injected = false;
  const isolated = loadSnapshots({
    async rmdir(dir, ...args) {
      if (dir === root && !injected) {
        injected = true;
        await fsp.writeFile(path.join(root, 'late'), 'created just before rmdir');
      }
      return fsp.rmdir(dir, ...args);
    },
  });

  await assert.rejects(isolated.removeVerifiedSnapshot(root, snapshot), (error) => {
    assert.ok(['FS_CHANGED', 'ENOTEMPTY', 'EEXIST'].includes(error.code));
    return true;
  });
  assert.equal(injected, true);
  assert.equal(await fsp.readFile(path.join(root, 'late'), 'utf8'), 'created just before rmdir');
});

test('cancellation prevents snapshot capture and verified deletion', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fsp.writeFile(file, 'contents');
  const snapshot = await snapshots.captureSnapshot(file);
  const job = { canceled: true, controller: new AbortController() };
  job.controller.abort();

  await assert.rejects(snapshots.captureSnapshot(file, { job }), { canceled: true });
  await assert.rejects(snapshots.assertSnapshot(file, snapshot, { job }), { canceled: true });
  await assert.rejects(snapshots.removeVerifiedSnapshot(file, snapshot, { job }), { canceled: true });
  assert.equal(await fsp.readFile(file, 'utf8'), 'contents');
});
