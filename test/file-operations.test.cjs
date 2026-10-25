const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { assertSnapshot } = require('../electron/file-snapshot.cjs');
const { createUndoRegistry } = require('../electron/undo-registry.cjs');

const operationsPath = path.resolve(__dirname, '../electron/file-operations.cjs');
const operations = require(operationsPath);

function loadOperations(overrides = {}) {
  function load(filename) {
    const module = { exports: {} };
    const source = fs.readFileSync(filename, 'utf8');
    const evaluate = vm.runInThisContext(`(function (require, module, exports) {\n${source}\n})`, { filename });
    evaluate((name) => {
      if (name === 'fs/promises') return { ...fsp, ...overrides.fsp };
      if (name === 'fs') return { ...fs, ...overrides.fs };
      if (name === './file-snapshot.cjs') return load(path.resolve(path.dirname(filename), name));
      return require(name);
    }, module, module.exports);
    return module.exports;
  }
  return load(operationsPath);
}

function fsError(code) {
  return Object.assign(new Error(`Injected ${code}`), { code });
}

async function fixture(t) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-operations-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const destDir = path.join(root, 'destination');
  await fsp.mkdir(sourceDir);
  await fsp.mkdir(destDir);
  return { root, sourceDir, destDir };
}

async function pair(t) {
  const setup = await fixture(t);
  const source = path.join(setup.sourceDir, 'item.txt');
  const dest = path.join(setup.destDir, 'item.txt');
  await fsp.writeFile(source, 'new contents');
  await fsp.writeFile(dest, 'existing contents');
  return { ...setup, source, dest };
}

async function assertText(file, expected) {
  assert.equal(await fsp.readFile(file, 'utf8'), expected);
}

async function assertMissing(file) {
  await assert.rejects(fsp.lstat(file), { code: 'ENOENT' });
}

async function assertNoWorkspace(dir) {
  assert.deepEqual((await fsp.readdir(dir)).filter((name) => name.startsWith('.mac-explorer-')), []);
}

test('copies a file without changing its source', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'item.txt');
  await fsp.writeFile(source, 'contents');
  const dest = await operations.copyItem(source, destDir);
  assert.equal(dest, path.join(destDir, 'item.txt'));
  await assertText(source, 'contents');
  await assertText(dest, 'contents');
  await assertNoWorkspace(destDir);
});

test('copies a directory tree and preserves symlink entries', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  await fsp.mkdir(path.join(source, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(source, 'nested', 'item'), 'contents');
  await fsp.symlink('nested/item', path.join(source, 'link'));
  await fsp.symlink('missing', path.join(source, 'broken'));
  const dest = await operations.copyItem(source, destDir);
  await assertText(path.join(dest, 'nested', 'item'), 'contents');
  assert.equal(await fsp.readlink(path.join(dest, 'link')), 'nested/item');
  assert.equal(await fsp.readlink(path.join(dest, 'broken')), 'missing');
  await assertText(path.join(source, 'nested', 'item'), 'contents');
  await assertNoWorkspace(destDir);
});

test('copying in the same directory creates a unique sibling', async (t) => {
  const { sourceDir } = await fixture(t);
  const source = path.join(sourceDir, 'item.txt');
  await fsp.writeFile(source, 'contents');
  const dest = await operations.copyItem(source, sourceDir);
  assert.equal(dest, path.join(sourceDir, 'item copy.txt'));
  await assertText(source, 'contents');
  await assertText(dest, 'contents');
});

test('keepBoth retains existing files and skips names occupied by broken symlinks', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const occupied = path.join(destDir, 'item copy.txt');
  await fsp.symlink('missing', occupied);
  const copied = await operations.copyItem(source, destDir, { conflict: 'keepBoth' });
  assert.equal(copied, path.join(destDir, 'item copy 2.txt'));
  await assertText(copied, 'new contents');
  await assertText(dest, 'existing contents');
  assert.equal(await fsp.readlink(occupied), 'missing');
});

for (const operation of ['copyItem', 'moveItem']) {
  test(`${operation} skips an existing destination without changing either file`, async (t) => {
    const { source, dest, destDir } = await pair(t);
    assert.equal(await operations[operation](source, destDir, { conflict: 'skip' }), null);
    await assertText(source, 'new contents');
    await assertText(dest, 'existing contents');
    await assertNoWorkspace(destDir);
  });
}

test('overwrite replaces an existing directory rather than merging its children', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const dest = path.join(destDir, 'folder');
  await fsp.mkdir(source);
  await fsp.mkdir(dest);
  await fsp.writeFile(path.join(source, 'new'), 'new contents');
  await fsp.writeFile(path.join(dest, 'old'), 'existing contents');
  assert.equal(await operations.copyItem(source, destDir, { conflict: 'overwrite' }), dest);
  await assertText(path.join(source, 'new'), 'new contents');
  await assertText(path.join(dest, 'new'), 'new contents');
  await assertMissing(path.join(dest, 'old'));
  await assertNoWorkspace(destDir);
});

test('a staging write failure preserves the existing destination', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const writer = async (_source, staged) => {
    await fsp.writeFile(staged, 'partial contents');
    throw fsError('ENOSPC');
  };
  await assert.rejects(operations.copyItem(source, destDir, { conflict: 'overwrite' }, writer), { code: 'ENOSPC' });
  await assertText(source, 'new contents');
  await assertText(dest, 'existing contents');
  await assertNoWorkspace(destDir);
});

test('cancellation after staging preserves the existing destination', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const job = { canceled: false, controller: new AbortController() };
  const writer = async (input, staged, opts) => {
    await operations.copyTree(input, staged, opts);
    job.canceled = true;
    job.controller.abort();
  };
  await assert.rejects(operations.copyItem(source, destDir, { conflict: 'overwrite', job }, writer), { canceled: true });
  await assertText(source, 'new contents');
  await assertText(dest, 'existing contents');
  await assertNoWorkspace(destDir);
});

test('cancelling an active stream preserves the destination and closes both streams', async (t) => {
  const { source, dest, destDir } = await pair(t);
  await fsp.writeFile(source, Buffer.alloc(1024 * 1024, 42));
  const job = { canceled: false, controller: new AbortController() };
  let input;
  let output;
  const isolated = loadOperations({ fs: {
    createReadStream(...args) {
      input = fs.createReadStream(...args);
      input.once('data', () => { job.canceled = true; job.controller.abort(); });
      return input;
    },
    createWriteStream(...args) { output = fs.createWriteStream(...args); return output; },
  } });
  await assert.rejects(isolated.copyItem(source, destDir, { conflict: 'overwrite', job }), { canceled: true });
  assert.equal(input.closed, true);
  assert.equal(output.closed, true);
  assert.equal((await fsp.stat(source)).size, 1024 * 1024);
  await assertText(dest, 'existing contents');
  await assertNoWorkspace(destDir);
});

test('copy and move reject their own directory and descendants, including a symlink alias', async (t) => {
  const { root, sourceDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const child = path.join(source, 'child');
  const alias = path.join(root, 'alias');
  await fsp.mkdir(child, { recursive: true });
  await fsp.writeFile(path.join(source, 'important'), 'original');
  await fsp.symlink(source, alias);
  for (const operation of ['copyItem', 'moveItem']) {
    for (const dest of [source, child, alias, path.join(alias, 'child')]) {
      await assert.rejects(operations[operation](source, dest, { conflict: 'overwrite' }), /하위 폴더/);
    }
  }
  await assertText(path.join(source, 'important'), 'original');
  assert.deepEqual((await fsp.readdir(source)).sort(), ['child', 'important']);
  assert.deepEqual(await fsp.readdir(child), []);
});

test('copy and move refuse to overwrite an ancestor containing the source', async (t) => {
  const { root } = await fixture(t);
  const ancestor = path.join(root, 'nested');
  const source = path.join(ancestor, 'nested');
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(ancestor, 'existing'), 'existing contents');
  await fsp.writeFile(path.join(source, 'important'), 'source contents');
  for (const operation of ['copyItem', 'moveItem']) {
    await assert.rejects(operations[operation](source, root, { conflict: 'overwrite' }), /원본을 포함/);
  }
  await assertText(path.join(ancestor, 'existing'), 'existing contents');
  await assertText(path.join(source, 'important'), 'source contents');
  await assertNoWorkspace(root);
});

test('broken destination links remain intact on rejection and can be explicitly overwritten', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'item');
  const dest = path.join(destDir, 'item');
  await fsp.writeFile(source, 'contents');
  await fsp.symlink('missing', dest);
  await assert.rejects(operations.copyItem(source, destDir), /이미 존재/);
  assert.equal(await fsp.readlink(dest), 'missing');
  assert.equal(await operations.copyItem(source, destDir, { conflict: 'skip' }), null);
  assert.equal(await fsp.readlink(dest), 'missing');
  await operations.copyItem(source, destDir, { conflict: 'overwrite' });
  assert.equal((await fsp.lstat(dest)).isSymbolicLink(), false);
  await assertText(dest, 'contents');
  await assertNoWorkspace(destDir);
});

test('moving an existing directory replaces the destination and removes only the source entry', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const dest = path.join(destDir, 'folder');
  await fsp.mkdir(source);
  await fsp.mkdir(dest);
  await fsp.writeFile(path.join(source, 'new'), 'new contents');
  await fsp.writeFile(path.join(dest, 'old'), 'existing contents');
  assert.equal(await operations.moveItem(source, destDir, { conflict: 'overwrite' }), dest);
  await assertMissing(source);
  await assertMissing(path.join(dest, 'old'));
  await assertText(path.join(dest, 'new'), 'new contents');
  await assertNoWorkspace(destDir);
});

test('moving to the same directory through an alias is a no-op', async (t) => {
  const { root, sourceDir } = await fixture(t);
  const source = path.join(sourceDir, 'item');
  const alias = path.join(root, 'alias');
  await fsp.writeFile(source, 'contents');
  await fsp.symlink(sourceDir, alias);
  assert.equal(await operations.moveItem(source, alias), null);
  await assertText(source, 'contents');
  assert.deepEqual(await fsp.readdir(sourceDir), ['item']);
});

for (const operation of ['copyItem', 'moveItem']) {
  test(`${operation} restores the existing destination when the final rename fails`, async (t) => {
    const { source, dest, destDir } = await pair(t);
    const isolated = loadOperations({ fsp: {
      async rename(from, to) {
        if (path.basename(from) === 'new' && to === dest) throw fsError('EIO');
        return fsp.rename(from, to);
      },
    } });
    await assert.rejects(isolated[operation](source, destDir, { conflict: 'overwrite' }), { code: 'EIO' });
    await assertText(source, 'new contents');
    await assertText(dest, 'existing contents');
    await assertNoWorkspace(destDir);
  });
}

test('a failed rollback preserves the backup and reports its recovery path', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (to === dest && ['new', 'previous'].includes(path.basename(from))) throw fsError('EIO');
      return fsp.rename(from, to);
    },
  } });
  let failure;
  await assert.rejects(isolated.copyItem(source, destDir, { conflict: 'overwrite' }), (err) => {
    failure = err;
    return err.code === 'EIO';
  });
  const workspaces = (await fsp.readdir(destDir)).filter((name) => name.startsWith('.mac-explorer-'));
  assert.equal(workspaces.length, 1);
  const backup = path.join(destDir, workspaces[0], 'previous');
  await assertText(backup, 'existing contents');
  await assertText(source, 'new contents');
  assert.ok(failure.message.includes(backup));
});

test('a destination changed during staging is preserved', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const writer = async (input, staged, opts) => {
    await operations.copyTree(input, staged, opts);
    await fsp.writeFile(dest, 'changed externally during staging');
  };
  await assert.rejects(operations.copyItem(source, destDir, { conflict: 'overwrite' }, writer), /작업 중 대상이 변경/);
  await assertText(source, 'new contents');
  await assertText(dest, 'changed externally during staging');
  await assertNoWorkspace(destDir);
});

test('EXDEV falls back to copying before removing the source', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (from === source) throw fsError('EXDEV');
      return fsp.rename(from, to);
    },
  } });
  assert.equal(await isolated.moveItem(source, destDir, { conflict: 'overwrite' }), dest);
  await assertMissing(source);
  await assertText(dest, 'new contents');
  await assertNoWorkspace(destDir);
});

test('a failed EXDEV copy leaves the source and old destination intact', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (from === source) throw fsError('EXDEV');
      return fsp.rename(from, to);
    },
  } });
  const writer = async (_source, staged) => {
    await fsp.writeFile(staged, 'partial');
    throw fsError('ENOSPC');
  };
  await assert.rejects(isolated.moveItem(source, destDir, { conflict: 'overwrite' }, writer), { code: 'ENOSPC' });
  await assertText(source, 'new contents');
  await assertText(dest, 'existing contents');
  await assertNoWorkspace(destDir);
});

test('EXDEV source cleanup failure preserves the fully committed destination', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (from === source) throw fsError('EXDEV');
      return fsp.rename(from, to);
    },
    async unlink(target) {
      if (target === source) throw fsError('EACCES');
      return fsp.unlink(target);
    },
  } });
  await assert.rejects(isolated.moveItem(source, destDir, { conflict: 'overwrite' }), (err) => {
    return err.code === 'EACCES' && err.committedDest === dest && err.message.includes(dest);
  });
  await assertText(source, 'new contents');
  await assertText(dest, 'new contents');
  await assertNoWorkspace(destDir);
});

for (const operation of ['copyItem', 'moveItem']) {
  test(`${operation} rejects a source edit after copying and preserves the old destination`, async (t) => {
    const { source, dest, destDir } = await pair(t);
    const isolated = loadOperations({ fsp: {
      async rename(from, to) {
        if (from === source) throw fsError('EXDEV');
        return fsp.rename(from, to);
      },
    } });
    const writer = async (input, staged, opts) => {
      await operations.copyTree(input, staged, opts);
      await fsp.writeFile(input, 'new edit after copying');
    };
    await assert.rejects(isolated[operation](source, destDir, { conflict: 'overwrite' }, writer), { code: 'FS_CHANGED' });
    await assertText(source, 'new edit after copying');
    await assertText(dest, 'existing contents');
    await assertNoWorkspace(destDir);
  });
}

test('EXDEV rejects new source children created after copying without deleting them', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, 'original'), 'original');
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (from === source) throw fsError('EXDEV');
      return fsp.rename(from, to);
    },
  } });
  const writer = async (input, staged, opts) => {
    await operations.copyTree(input, staged, opts);
    await fsp.writeFile(path.join(input, 'new'), 'created after copying');
  };
  await assert.rejects(isolated.moveItem(source, destDir, {}, writer), { code: 'FS_CHANGED' });
  await assertText(path.join(source, 'new'), 'created after copying');
  await assertText(path.join(source, 'original'), 'original');
  await assertMissing(path.join(destDir, 'folder'));
  await assertNoWorkspace(destDir);
});

test('a source edited while its stream is being read is never committed', async (t) => {
  const { source, dest, destDir } = await pair(t);
  await fsp.writeFile(source, Buffer.alloc(1024 * 1024, 1));
  const isolated = loadOperations({ fs: {
    createReadStream(...args) {
      const input = fs.createReadStream(...args);
      input.once('data', () => fs.writeFileSync(source, Buffer.alloc(1024 * 1024, 2)));
      return input;
    },
  } });
  await assert.rejects(isolated.copyItem(source, destDir, { conflict: 'overwrite' }), { code: 'FS_CHANGED' });
  assert.deepEqual(await fsp.readFile(source), Buffer.alloc(1024 * 1024, 2));
  await assertText(dest, 'existing contents');
  await assertNoWorkspace(destDir);
});

test('overwrite detects edits to a destination child even when its parent stat is unchanged', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const dest = path.join(destDir, 'folder');
  await fsp.mkdir(source);
  await fsp.mkdir(dest);
  await fsp.writeFile(path.join(source, 'new'), 'new contents');
  await fsp.writeFile(path.join(dest, 'existing'), 'old contents');
  const before = await fsp.lstat(dest, { bigint: true });
  const writer = async (input, staged, opts) => {
    await operations.copyTree(input, staged, opts);
    await fsp.writeFile(path.join(dest, 'existing'), 'edited externally');
    const after = await fsp.lstat(dest, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
  };
  await assert.rejects(operations.copyItem(source, destDir, { conflict: 'overwrite' }, writer), /작업 중 대상이 변경/);
  await assertText(path.join(dest, 'existing'), 'edited externally');
  await assertMissing(path.join(dest, 'new'));
  await assertNoWorkspace(destDir);
});

test('EXDEV preserves a source changed after commit and reports the complete destination', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (from === source) throw fsError('EXDEV');
      await fsp.rename(from, to);
      if (to === dest && path.basename(from) === 'new') await fsp.writeFile(source, 'edited after commit');
    },
  } });
  await assert.rejects(isolated.moveItem(source, destDir, { conflict: 'overwrite' }), (err) => {
    return err.code === 'FS_CHANGED' && err.committedDest === dest && err.retainedPath === source;
  });
  await assertText(source, 'edited after commit');
  await assertText(dest, 'new contents');
  await assertNoWorkspace(destDir);
});

test('EXDEV stops cleanup when a new source child appears between verified deletions', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const dest = path.join(destDir, 'folder');
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, 'a'), 'first');
  await fsp.writeFile(path.join(source, 'b'), 'second');
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (from === source) throw fsError('EXDEV');
      return fsp.rename(from, to);
    },
    async unlink(p) {
      await fsp.unlink(p);
      if (p === path.join(source, 'a')) await fsp.writeFile(path.join(source, 'late'), 'new contents');
    },
  } });
  await assert.rejects(isolated.moveItem(source, destDir), (err) => {
    return err.code === 'FS_CHANGED' && err.committedDest === dest && err.removedCount === 1;
  });
  await assertText(path.join(source, 'late'), 'new contents');
  await assertText(path.join(source, 'b'), 'second');
  await assertText(path.join(dest, 'a'), 'first');
  await assertText(path.join(dest, 'b'), 'second');
  await assertNoWorkspace(destDir);
});

test('a backup changed after commit is retained with its recovery path', async (t) => {
  const { source, dest, destDir } = await pair(t);
  let backup;
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      await fsp.rename(from, to);
      if (from === dest) backup = to;
      if (to === dest && path.basename(from) === 'new') await fsp.writeFile(backup, 'edited through an open handle');
    },
  } });
  await assert.rejects(isolated.copyItem(source, destDir, { conflict: 'overwrite' }), (err) => {
    return err.code === 'FS_CHANGED' && err.committedDest === dest && err.recoveryPath === backup && err.message.includes(backup);
  });
  await assertText(backup, 'edited through an open handle');
  await assertText(dest, 'new contents');
  await assertText(source, 'new contents');
  assert.deepEqual(await fsp.readdir(path.dirname(backup)), ['previous']);
});

test('a new backup child appearing just before rmdir is retained instead of recursively removed', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const dest = path.join(destDir, 'folder');
  await fsp.mkdir(source);
  await fsp.mkdir(dest);
  await fsp.writeFile(path.join(source, 'new'), 'new contents');
  await fsp.writeFile(path.join(dest, 'old'), 'old contents');
  let backup;
  const isolated = loadOperations({ fsp: {
    async rmdir(p) {
      if (path.basename(p) === 'previous') {
        backup = p;
        await fsp.writeFile(path.join(p, 'late'), 'created during cleanup');
      }
      return fsp.rmdir(p);
    },
  } });
  await assert.rejects(isolated.copyItem(source, destDir, { conflict: 'overwrite' }), (err) => {
    return ['ENOTEMPTY', 'EEXIST'].includes(err.code) && err.committedDest === dest && err.recoveryPath === backup;
  });
  await assertText(path.join(backup, 'late'), 'created during cleanup');
  await assertText(path.join(dest, 'new'), 'new contents');
});

test('EXDEV and overwrite cleanup handle their own hardlink ctime changes', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const dest = path.join(destDir, 'folder');
  for (const folder of [source, dest]) {
    await fsp.mkdir(path.join(folder, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(folder, 'a'), folder === source ? 'new contents' : 'old contents');
    await fsp.link(path.join(folder, 'a'), path.join(folder, 'nested', 'b'));
  }
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (from === source) throw fsError('EXDEV');
      return fsp.rename(from, to);
    },
  } });
  assert.equal(await isolated.moveItem(source, destDir, { conflict: 'overwrite' }), dest);
  await assertMissing(source);
  await assertText(path.join(dest, 'a'), 'new contents');
  await assertText(path.join(dest, 'nested', 'b'), 'new contents');
  await assertNoWorkspace(destDir);
});

test('cancellation after backup rename finishes committed cleanup', async (t) => {
  const { source, dest, destDir } = await pair(t);
  const job = { canceled: false, controller: new AbortController() };
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (from === source) throw fsError('EXDEV');
      await fsp.rename(from, to);
      if (from === dest) { job.canceled = true; job.controller.abort(); }
    },
  } });
  assert.equal(await isolated.moveItem(source, destDir, { conflict: 'overwrite', job }), dest);
  await assertMissing(source);
  await assertText(dest, 'new contents');
  await assertNoWorkspace(destDir);
});

test('commit metadata records the published identity without changing copied timestamps', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, 'file'), 'contents');
  await fsp.symlink('file', path.join(source, 'link'));
  const atime = new Date('2001-02-03T04:05:06Z');
  const mtime = new Date('2002-03-04T05:06:07Z');
  for (const name of ['', 'file']) await fsp.utimes(path.join(source, name), atime, mtime);
  await fsp.lutimes(path.join(source, 'link'), atime, mtime);
  let metadata;
  const dest = await operations.copyItem(source, destDir, { onCommitted(value) { metadata = value; } });
  assert.equal(metadata.source, source);
  assert.equal(metadata.dest, dest);
  assert.equal(metadata.sourceStaged, false);
  for (const name of ['', 'file', 'link']) {
    const stat = await fsp.lstat(path.join(dest, name));
    assert.ok(Math.abs(stat.atimeMs - atime.getTime()) < 2);
    assert.ok(Math.abs(stat.mtimeMs - mtime.getTime()) < 2);
  }
  await assertSnapshot(dest, metadata.snapshot);
});

test('post-commit edits cannot become the original Undo snapshot', async (t) => {
  const { source, dest, destDir } = await pair(t);
  let metadata;
  assert.equal(await operations.copyItem(source, destDir, {
    conflict: 'overwrite',
    async onCommitted(value) {
      metadata = value;
      await fsp.writeFile(value.dest, 'edited after publication');
    },
  }), dest);
  await assert.rejects(assertSnapshot(dest, metadata.snapshot), { code: 'FS_CHANGED' });
  await assertText(dest, 'edited after publication');
});

test('an Undo metadata consumer failure never rolls back a completed copy', async (t) => {
  const { source, dest, destDir } = await pair(t);
  assert.equal(await operations.copyItem(source, destDir, {
    conflict: 'overwrite', onCommitted() { throw new Error('consumer failed'); },
  }), dest);
  await assertText(dest, 'new contents');
  await assertText(source, 'new contents');
  await assertNoWorkspace(destDir);
});

test('a destination created during metadata preparation is preserved', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const dest = path.join(destDir, 'folder');
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, 'file'), 'contents');
  let injected = false;
  const isolated = loadOperations({ fsp: {
    async readdir(p, ...args) {
      const names = await fsp.readdir(p, ...args);
      if (path.basename(p) === 'new' && path.dirname(p).startsWith(path.join(destDir, '.mac-explorer-')) && !injected) {
        injected = true;
        await fsp.writeFile(dest, 'created externally');
      }
      return names;
    },
  } });
  await assert.rejects(isolated.copyItem(source, destDir, { onCommitted() {} }), { code: 'FS_CHANGED' });
  assert.equal(injected, true);
  await assertText(dest, 'created externally');
  await assertNoWorkspace(destDir);
});

test('failed staging cleanup reports its own workspace and keeps the original error', async (t) => {
  const { source, dest, destDir } = await pair(t);
  let workspace;
  const isolated = loadOperations({ fsp: {
    async rm(p, options) {
      if (path.dirname(p) === destDir && path.basename(p).startsWith('.mac-explorer-')) {
        workspace = p;
        throw fsError('EACCES');
      }
      return fsp.rm(p, options);
    },
  } });
  const writer = async (_input, staged) => {
    await fsp.writeFile(staged, 'partial');
    throw fsError('ENOSPC');
  };
  await assert.rejects(isolated.copyItem(source, destDir, { conflict: 'overwrite' }, writer), (err) => {
    return err.code === 'ENOSPC' && err.cleanupPath === workspace && err.message.includes(workspace);
  });
  await assertText(source, 'new contents');
  await assertText(dest, 'existing contents');
  await assertText(path.join(workspace, 'new'), 'partial');
});

test('Undo lineage survives EXDEV moves and updates the earlier creation inode', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'item');
  const dest = path.join(destDir, 'item');
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (from === source || from === dest) throw fsError('EXDEV');
      return fsp.rename(from, to);
    },
  } });
  const registry = createUndoRegistry({ moveItem: isolated.moveItem, trashItem: (p) => fsp.rm(p, { recursive: true }) });
  let created;
  await operations.createItem(sourceDir, 'item', { onCommitted(value) { created = registry.recordCreate(owner, value); } });
  const originalInode = (await fsp.lstat(source)).ino;
  let metadata;
  await isolated.moveItem(source, destDir, { onCommitted(value) { metadata = value; } });
  const moved = registry.recordMove(owner, metadata);
  assert.notEqual((await fsp.lstat(dest)).ino, originalInode);
  assert.equal((await registry.undo(owner, moved.token)).ok, true);
  assert.equal((await registry.undo(owner, created.token)).ok, true);
  await assertMissing(source);
  await assertMissing(dest);
});

test('Undo can retry after a verified rollback changes its own source ctime', async (t) => {
  const { sourceDir } = await fixture(t);
  const original = path.join(sourceDir, 'original');
  const renamed = path.join(sourceDir, 'renamed');
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let failOnce = true;
  const isolated = loadOperations({ fsp: {
    async rename(from, to) {
      if (to === original && path.basename(from) === 'new' && failOnce) {
        failOnce = false;
        throw fsError('EIO');
      }
      return fsp.rename(from, to);
    },
  } });
  const registry = createUndoRegistry({ moveItem: isolated.moveItem, trashItem: (p) => fsp.rm(p) });
  let created;
  await operations.createItem(sourceDir, 'original', { onCommitted(value) { created = registry.recordCreate(owner, value); } });
  let metadata;
  await operations.moveItem(original, sourceDir, { name: 'renamed', onCommitted(value) { metadata = value; } });
  const moved = registry.recordMove(owner, metadata);
  assert.equal((await registry.undo(owner, moved.token)).ok, false);
  await assertText(renamed, '');
  assert.equal((await registry.undo(owner, moved.token)).ok, true);
  assert.equal((await registry.undo(owner, created.token)).ok, true);
  await assertMissing(original);
});

for (const mode of [0o700, 0o600]) {
  test(`copy preserves file permissions ${mode.toString(8)}`, async (t) => {
    const { sourceDir, destDir } = await fixture(t);
    const source = path.join(sourceDir, mode === 0o700 ? 'launch.sh' : 'private.txt');
    await fsp.writeFile(source, mode === 0o700 ? '#!/bin/sh\nexit 0\n' : 'private contents');
    await fsp.chmod(source, mode);
    const dest = await operations.copyItem(source, destDir);
    assert.equal((await fsp.stat(source)).mode & 0o7777, mode);
    assert.equal((await fsp.stat(dest)).mode & 0o7777, mode);
    await assertNoWorkspace(destDir);
  });
}

test('copy preserves private directory permissions after copying its children', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'private');
  const child = path.join(source, 'nested');
  await fsp.mkdir(child, { recursive: true });
  await fsp.writeFile(path.join(child, 'item'), 'contents');
  await fsp.chmod(source, 0o700);
  await fsp.chmod(child, 0o700);
  const dest = await operations.copyItem(source, destDir);
  assert.equal((await fsp.stat(dest)).mode & 0o7777, 0o700);
  assert.equal((await fsp.stat(path.join(dest, 'nested'))).mode & 0o7777, 0o700);
  await assertText(path.join(dest, 'nested', 'item'), 'contents');
});

test('copy preserves file and directory access and modification times', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const file = path.join(source, 'item');
  await fsp.mkdir(source);
  await fsp.writeFile(file, 'contents');
  await fsp.utimes(file, new Date('2003-02-01T01:02:03Z'), new Date('2004-03-02T04:05:06Z'));
  await fsp.utimes(source, new Date('2005-04-03T07:08:09Z'), new Date('2006-05-04T10:11:12Z'));
  const expectedFile = await fsp.stat(file);
  const expectedDirectory = await fsp.stat(source);
  const dest = await operations.copyItem(source, destDir);
  // Inspect timestamps before reads or directory listings can change destination atime.
  const actualDirectory = await fsp.stat(dest);
  const actualFile = await fsp.stat(path.join(dest, 'item'));
  for (const [actual, expected] of [[actualFile, expectedFile], [actualDirectory, expectedDirectory]]) {
    assert.equal(actual.atimeMs, expected.atimeMs);
    assert.equal(actual.mtimeMs, expected.mtimeMs);
  }
  await assertText(path.join(dest, 'item'), 'contents');
});

test('copy preserves symbolic link timestamps without changing the link target', async (t) => {
  const { root, sourceDir, destDir } = await fixture(t);
  const target = path.join(root, 'target');
  const source = path.join(sourceDir, 'link');
  await fsp.writeFile(target, 'target contents');
  await fsp.symlink(target, source);
  await fsp.utimes(target, new Date('2003-02-01T01:02:03Z'), new Date('2004-03-02T04:05:06Z'));
  await fsp.lutimes(source, new Date('2005-04-03T07:08:09Z'), new Date('2006-05-04T10:11:12Z'));
  const expectedLink = await fsp.lstat(source);
  const expectedTarget = await fsp.stat(target);
  const dest = await operations.copyItem(source, destDir);
  const actualLink = await fsp.lstat(dest);
  const actualTarget = await fsp.stat(target);
  assert.equal(actualLink.isSymbolicLink(), true);
  assert.equal(actualLink.atimeMs, expectedLink.atimeMs);
  assert.equal(actualLink.mtimeMs, expectedLink.mtimeMs);
  assert.equal(actualTarget.atimeMs, expectedTarget.atimeMs);
  assert.equal(actualTarget.mtimeMs, expectedTarget.mtimeMs);
  assert.equal(await fsp.readlink(dest), target);
});

test('batch validation protects another selected source inside an overwritten directory', async (t) => {
  const { root, sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'folder');
  const existing = path.join(destDir, 'folder');
  const otherSource = path.join(existing, 'selected.txt');
  const alias = path.join(root, 'existing-alias');
  await fsp.mkdir(source);
  await fsp.mkdir(existing);
  await fsp.writeFile(path.join(source, 'new'), 'new contents');
  await fsp.writeFile(otherSource, 'selected original');
  await fsp.symlink(existing, alias);
  for (const paths of [[source, otherSource], [otherSource, source], [source, path.join(alias, 'selected.txt')]]) {
    await assert.rejects(operations.validateBatch(paths, destDir, { conflict: 'overwrite' }), /선택한 원본을 포함/);
  }
  await operations.validateBatch([source, otherSource], destDir, { conflict: 'keepBoth' });
  await assertText(path.join(source, 'new'), 'new contents');
  await assertText(otherSource, 'selected original');
  assert.deepEqual(await fsp.readdir(existing), ['selected.txt']);
  await assertNoWorkspace(destDir);
});

test('move with an explicit name restores the exact original basename', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'document copy.txt');
  const expected = path.join(destDir, 'document.txt');
  await fsp.writeFile(source, 'restored contents');
  assert.equal(await operations.moveItem(source, destDir, { name: 'document.txt' }), expected);
  await assertText(expected, 'restored contents');
  await assertMissing(source);
  await assertMissing(path.join(destDir, 'document copy.txt'));
  await assertNoWorkspace(destDir);
});

test('move with an explicit name can rename within the same directory', async (t) => {
  const { sourceDir } = await fixture(t);
  const source = path.join(sourceDir, 'before.txt');
  const expected = path.join(sourceDir, 'after.txt');
  await fsp.writeFile(source, 'contents');
  assert.equal(await operations.moveItem(source, sourceDir, { name: 'after.txt' }), expected);
  await assertText(expected, 'contents');
  await assertMissing(source);
  assert.deepEqual(await fsp.readdir(sourceDir), ['after.txt']);
});

test('restoring an exact name refuses to replace an existing original file', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'document copy.txt');
  const original = path.join(destDir, 'document.txt');
  await fsp.writeFile(source, 'contents to restore');
  await fsp.writeFile(original, 'new file at original location');
  await assert.rejects(operations.moveItem(source, destDir, { name: 'document.txt' }), /이미 존재/);
  await assertText(source, 'contents to restore');
  await assertText(original, 'new file at original location');
  assert.deepEqual(await fsp.readdir(destDir), ['document.txt']);
});

test('invalid explicit names are rejected before moving the source', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'item.txt');
  await fsp.writeFile(source, 'original contents');
  for (const name of ['', '.', '..', '../outside', '/absolute', 'nested/item', 'nul\0name', 42, false, {}, []]) {
    await assert.rejects(operations.moveItem(source, destDir, { name }), /올바른 파일 이름/);
  }
  await assertText(source, 'original contents');
  assert.deepEqual(await fsp.readdir(destDir), []);
});

test('batch overwrite protects a selected file that is also another item destination', async (t) => {
  const { root, source, dest, destDir } = await pair(t);
  const alias = path.join(root, 'destination-alias');
  await fsp.symlink(destDir, alias);
  for (const paths of [[source, dest], [dest, source], [source, path.join(alias, 'item.txt')]]) {
    await assert.rejects(operations.validateBatch(paths, destDir, { conflict: 'overwrite' }), /선택한/);
  }
  await operations.validateBatch([source, dest], destDir, { conflict: 'keepBoth' });
  await assertText(source, 'new contents');
  await assertText(dest, 'existing contents');
  await assertNoWorkspace(destDir);
});

test('batch overwrite protects selected files when an explicit destination name is used', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const source = path.join(sourceDir, 'renamed.txt');
  const selected = path.join(destDir, 'original.txt');
  await fsp.writeFile(source, 'restoration contents');
  await fsp.writeFile(selected, 'selected original');
  await assert.rejects(operations.validateBatch([source, selected], destDir, {
    name: 'original.txt', conflict: 'overwrite',
  }), /선택한 원본/);
  await assertText(source, 'restoration contents');
  await assertText(selected, 'selected original');
});

test('batch overwrite rejects different sources that would replace the same destination', async (t) => {
  const { root, sourceDir, destDir } = await fixture(t);
  const otherDir = path.join(root, 'other');
  await fsp.mkdir(otherDir);
  const first = path.join(sourceDir, 'same.txt');
  const second = path.join(otherDir, 'same.txt');
  await fsp.writeFile(first, 'first selected contents');
  await fsp.writeFile(second, 'second selected contents');
  await fsp.writeFile(path.join(destDir, 'same.txt'), 'existing contents');
  for (const paths of [[first, second], [second, first]]) {
    await assert.rejects(operations.validateBatch(paths, destDir, { conflict: 'overwrite' }));
  }
  await operations.validateBatch([first, second], destDir, { conflict: 'keepBoth' });
  await assertText(first, 'first selected contents');
  await assertText(second, 'second selected contents');
  await assertText(path.join(destDir, 'same.txt'), 'existing contents');
});

test('batch overwrite rejects distinct names planned for the same explicit name', async (t) => {
  const { sourceDir, destDir } = await fixture(t);
  const first = path.join(sourceDir, 'first.txt');
  const second = path.join(sourceDir, 'second.txt');
  await fsp.writeFile(first, 'first contents');
  await fsp.writeFile(second, 'second contents');
  await assert.rejects(operations.validateBatch([first, second], destDir, {
    name: 'restored.txt', conflict: 'overwrite',
  }));
  await assertText(first, 'first contents');
  await assertText(second, 'second contents');
  assert.deepEqual(await fsp.readdir(destDir), []);
});

test('overwrite protects a selected source reached through a different hard link', async (t) => {
  const { root, source, dest, destDir } = await pair(t);
  const selectedAlias = path.join(root, 'selected-original.txt');
  await fsp.link(dest, selectedAlias);
  await assert.rejects(operations.moveItem(source, destDir, {
    conflict: 'overwrite', protectedDestinations: [selectedAlias],
  }), /선택한 원본이나 이번 작업/);
  await assertText(source, 'new contents');
  await assertText(dest, 'existing contents');
  await assertText(selectedAlias, 'existing contents');
  await assertNoWorkspace(destDir);
});

test('overwrite protects a completed destination through a case-insensitive alias', async (t) => {
  const { root, sourceDir, destDir } = await fixture(t);
  const otherDir = path.join(root, 'other');
  const first = path.join(sourceDir, 'Report.txt');
  await fsp.mkdir(otherDir);
  await fsp.writeFile(first, 'first selected contents');
  const originalStat = await fsp.stat(first);
  const aliasStat = await operations.statEntry(path.join(sourceDir, 'report.txt'));
  if (!aliasStat || aliasStat.dev !== originalStat.dev || aliasStat.ino !== originalStat.ino) {
    t.skip('fixture filesystem uses case-sensitive filenames');
    return;
  }
  const second = path.join(otherDir, 'report.txt');
  await fsp.writeFile(second, 'second selected contents');
  const completed = await operations.moveItem(first, destDir);
  await assert.rejects(operations.moveItem(second, destDir, {
    conflict: 'overwrite', protectedDestinations: [completed],
  }), /선택한 원본이나 이번 작업/);
  await assertMissing(first);
  await assertText(completed, 'first selected contents');
  await assertText(second, 'second selected contents');
  await assertNoWorkspace(destDir);
});

test('renaming only letter case succeeds without replacing a separate hard link', async (t) => {
  const { sourceDir } = await fixture(t);
  const source = path.join(sourceDir, 'Original.txt');
  await fsp.writeFile(source, 'contents');
  const renamed = await operations.moveItem(source, sourceDir, { name: 'original.txt' });
  assert.equal(renamed, path.join(sourceDir, 'original.txt'));
  assert.deepEqual(await fsp.readdir(sourceDir), ['original.txt']);
  await assertText(renamed, 'contents');
  const hardLink = path.join(sourceDir, 'distinct.txt');
  await fsp.link(renamed, hardLink);
  await assert.rejects(operations.moveItem(renamed, sourceDir, { name: 'distinct.txt' }));
  await assertText(renamed, 'contents');
  await assertText(hardLink, 'contents');
});
