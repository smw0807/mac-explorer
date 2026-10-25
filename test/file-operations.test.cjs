const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const operationsPath = path.resolve(__dirname, '../electron/file-operations.cjs');
const operations = require(operationsPath);

function loadOperations(overrides = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(operationsPath, 'utf8');
  const evaluate = vm.runInThisContext(`(function (require, module, exports) {\n${source}\n})`, {
    filename: operationsPath,
  });
  evaluate((name) => {
    if (name === 'fs/promises') return { ...fsp, ...overrides.fsp };
    if (name === 'fs') return { ...fs, ...overrides.fs };
    return require(name);
  }, module, module.exports);
  return module.exports;
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
    async rm(target, options) {
      if (target === source) throw fsError('EACCES');
      return fsp.rm(target, options);
    },
  } });
  await assert.rejects(isolated.moveItem(source, destDir, { conflict: 'overwrite' }), (err) => {
    return err.code === 'EACCES' && err.committedDest === dest;
  });
  await assertText(source, 'new contents');
  await assertText(dest, 'new contents');
  await assertNoWorkspace(destDir);
});
