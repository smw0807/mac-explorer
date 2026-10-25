const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);
const archivePath = path.resolve(__dirname, '../electron/archive.cjs');
const archiveRequire = createRequire(archivePath);
function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}
const hasTools = executable('/usr/bin/unzip')
  && (process.platform !== 'darwin' || executable('/usr/bin/ditto'));
const archiveTest = (name, fn) => test(name, { skip: !hasTools && 'archive commands unavailable' }, fn);

function loadArchive(overrides) {
  const module = { exports: {} };
  const evaluate = vm.runInThisContext(`(function (require, module, exports) {\n${fs.readFileSync(archivePath, 'utf8')}\n})`, {
    filename: archivePath,
  });
  evaluate((name) => Object.hasOwn(overrides, name) ? overrides[name] : archiveRequire(name), module, module.exports);
  return module.exports;
}

// Exercise production ditto on macOS. Linux CI substitutes only the unavailable
// command, retaining the real CRC validator and final file-operation transaction.
function archiveWithCommands(hooks = {}, overrides = {}) {
  const commands = [];
  const archive = loadArchive({
    ...overrides,
    child_process: {
      execFile(command, args, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        const call = { command, args, options, source: args.at(-2), destination: args.at(-1) };
        commands.push(call);
        (async () => {
          await hooks.beforeCommand?.(call);
          const cloning = command === '/usr/bin/ditto' && args.includes('--clone');
          const extracting = command === '/usr/bin/ditto' && args.includes('-x');
          if (cloning) await hooks.beforeClone?.(call);
          if (extracting) await hooks.beforeExtract?.(call);
          let result;
          if (command !== '/usr/bin/ditto' || process.platform === 'darwin') {
            result = await execFileP(command, args, options);
          } else if (cloning) {
            await fsp.copyFile(call.source, call.destination);
            result = { stdout: '', stderr: '' };
          } else if (extracting) {
            result = await execFileP('/usr/bin/unzip', ['-q', '-o', '-^', '-P', '', call.source, '-d', call.destination], options);
          } else {
            throw new Error(`Unexpected ditto command: ${args.join(' ')}`);
          }
          if (cloning) await hooks.afterClone?.(call);
          if (extracting) await hooks.afterExtract?.(call);
          return result;
        })().then(({ stdout, stderr }) => callback(null, stdout, stderr), (err) => callback(err, '', ''));
      },
    },
  });
  return { ...archive, commands };
}

async function fixture(t) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-extract-test-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal stored ZIP fixtures support literal control characters and Unix links
// without depending on Python or a particular host zip command.
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? '');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = entry.mode ?? (entry.name.endsWith('/') ? 0o40755 : 0o100644);
    central.writeUInt32LE(((mode << 16) | (entry.name.endsWith('/') ? 16 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    if (entry.corrupt) data[0] ^= 1;
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function writeZip(root, name = 'archive.zip', entries = [{ name: 'item.txt', data: 'new contents' }]) {
  const zip = path.join(root, name);
  await fsp.writeFile(zip, storedZip(entries));
  return zip;
}

async function names(root) { return (await fsp.readdir(root)).sort(); }

archiveTest('CRC corruption is rejected before ditto can publish damaged contents', async (t) => {
  const root = await fixture(t);
  const zip = await writeZip(root, 'damaged.zip', [
    { name: 'good.txt', data: 'good' },
    { name: 'bad.txt', data: 'damaged content', corrupt: true },
  ]);
  const original = await fsp.readFile(zip);
  const archive = archiveWithCommands();
  await assert.rejects(archive.extract(zip), { code: 'INVALID_ARCHIVE' });
  assert.equal(archive.commands.filter((call) => call.args.includes('-x')).length, 0);
  assert.deepEqual(await fsp.readFile(zip), original);
  assert.deepEqual(await names(root), ['damaged.zip']);
});

archiveTest('truncated ZIP validation fails without an output folder or staging files', async (t) => {
  const root = await fixture(t);
  const zip = path.join(root, 'truncated.zip');
  await fsp.writeFile(zip, storedZip([{ name: 'item.txt', data: 'data' }]).subarray(0, 40));
  await assert.rejects(archiveWithCommands().extract(zip), { code: 'INVALID_ARCHIVE' });
  assert.deepEqual(await names(root), ['truncated.zip']);
});

test('encrypted ZIP files fail without waiting for a password prompt', {
  skip: !hasTools || !executable('/usr/bin/zip') ? 'zip commands unavailable' : false,
}, async (t) => {
  const root = await fixture(t);
  const zip = path.join(root, 'encrypted.zip');
  await fsp.writeFile(path.join(root, 'item.txt'), 'encrypted fixture contents');
  await execFileP('/usr/bin/zip', ['-q', '-P', 'fixture-password', zip, 'item.txt'], { cwd: root });
  const archive = archiveWithCommands({
    beforeCommand({ command, options }) {
      // A regression must fail this test promptly instead of leaving a child alive.
      if (command === '/usr/bin/unzip') options.timeout = 2000;
    },
  });
  await assert.rejects(archive.extract(zip), (err) => {
    assert.equal(err.code, 'INVALID_ARCHIVE');
    assert.equal(err.cause.code, 82);
    assert.equal(err.cause.killed, false);
    return true;
  });
  assert.equal(archive.commands.some((call) => call.args.includes('-x')), false);
  assert.deepEqual(await names(root), ['encrypted.zip', 'item.txt']);
});

archiveTest('shell archive defaults cannot change validation or extraction options', async (t) => {
  const root = await fixture(t);
  const zip = await writeZip(root);
  const defaults = {
    ZIPOPT: '-0', UNZIP: '-:', UNZIPOPT: '-:', ZIPINFO: '-v', ZIPINFOOPT: '-v', DITTONORSRC: '1',
  };
  const previous = Object.fromEntries(Object.keys(defaults).map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, defaults);
  const archive = archiveWithCommands({
    beforeCommand({ options }) {
      for (const name of Object.keys(defaults)) assert.equal(Object.hasOwn(options.env, name), false);
    },
  });
  const output = await archive.extract(zip);
  assert.equal(await fsp.readFile(path.join(output, 'item.txt'), 'utf8'), 'new contents');
  assert.deepEqual(await names(root), ['archive', 'archive.zip']);
});

for (const [kind, failure] of [
  ['command error', { code: 1 }],
  ['terminated process', { signal: 'SIGABRT', code: null }],
]) {
  archiveTest(`partial extraction is removed after a ${kind}`, async (t) => {
    const root = await fixture(t);
    const zip = await writeZip(root);
    const archive = archiveWithCommands({
      async beforeExtract({ destination }) {
        await fsp.mkdir(destination, { recursive: true });
        await fsp.writeFile(path.join(destination, 'partial.txt'), 'incomplete');
        throw Object.assign(new Error('Injected extraction failure'), failure);
      },
    });
    await assert.rejects(archive.extract(zip), /Injected extraction failure/);
    assert.deepEqual(await names(root), ['archive.zip']);
  });
}

for (const failedExtraction of [true, false]) {
  archiveTest(`cleanup failure reports its workspace after ${failedExtraction ? 'failed' : 'completed'} extraction`, async (t) => {
    const root = await fixture(t);
    const zip = await writeZip(root);
    let workspace;
    const archive = archiveWithCommands({
      afterClone({ destination }) { workspace = path.dirname(destination); },
      async beforeExtract({ destination }) {
        if (!failedExtraction) return;
        await fsp.mkdir(destination);
        await fsp.writeFile(path.join(destination, 'partial.txt'), 'incomplete');
        throw new Error('Injected extraction failure');
      },
    }, { 'fs/promises': { ...fsp,
      async rm(target, options) {
        if (target === workspace) throw Object.assign(new Error('Injected cleanup permission failure'), { code: 'EACCES' });
        return fsp.rm(target, options);
      },
    } });
    await assert.rejects(archive.extract(zip), (error) => {
      assert.equal(error.cleanupPath, workspace);
      assert.equal(error.message.includes(workspace), true);
      if (failedExtraction) {
        assert.match(error.message, /Injected extraction failure/);
        assert.equal(error.committedDest, undefined);
      } else {
        assert.equal(error.committedDest, path.join(root, 'archive'));
        assert.equal(error.message.includes(error.committedDest), true);
      }
      return true;
    });
    assert.equal((await fsp.stat(zip)).isFile(), true);
    if (failedExtraction) await assert.rejects(fsp.lstat(path.join(root, 'archive')), { code: 'ENOENT' });
    else assert.equal(await fsp.readFile(path.join(root, 'archive/item.txt'), 'utf8'), 'new contents');
    assert.deepEqual(await names(root), [path.basename(workspace), 'archive.zip', ...(failedExtraction ? [] : ['archive'])].sort());
  });
}

for (const kind of ['symbolic link', 'regular file']) {
  archiveTest(`a successful extractor cannot publish a ${kind} as the output root`, async (t) => {
    const root = await fixture(t);
    const zip = await writeZip(root);
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'victim.txt'), 'outside original');
    const archive = archiveWithCommands({
      async afterExtract({ destination }) {
        await fsp.rm(destination, { recursive: true });
        if (kind === 'symbolic link') await fsp.symlink(outside, destination);
        else await fsp.writeFile(destination, 'unexpected root file');
      },
    });
    await assert.rejects(archive.extract(zip));
    assert.equal(await fsp.readFile(path.join(outside, 'victim.txt'), 'utf8'), 'outside original');
    assert.deepEqual(await names(root), ['archive.zip', 'outside']);
  });
}

archiveTest('extraction preserves nested Unicode names, newlines, empty folders, and links', async (t) => {
  const root = await fixture(t);
  const zip = await writeZip(root, '자료.zip', [
    { name: '문서/' },
    { name: '문서/내용.txt', data: '한글 contents' },
    { name: '문서/line\nbreak.txt', data: 'newline name' },
    { name: 'empty/' },
    { name: 'outside-link', data: '../outside.txt', mode: 0o120777 },
    { name: 'broken-link', data: 'missing', mode: 0o120777 },
  ]);
  await fsp.writeFile(path.join(root, 'outside.txt'), 'outside');
  const output = await archiveWithCommands().extract(zip);
  assert.equal(output, path.join(root, '자료'));
  assert.equal(await fsp.readFile(path.join(output, '문서/내용.txt'), 'utf8'), '한글 contents');
  assert.equal(await fsp.readFile(path.join(output, '문서/line\nbreak.txt'), 'utf8'), 'newline name');
  assert.deepEqual(await fsp.readdir(path.join(output, 'empty')), []);
  assert.equal(await fsp.readlink(path.join(output, 'outside-link')), '../outside.txt');
  assert.equal(await fsp.readlink(path.join(output, 'broken-link')), 'missing');
  assert.equal(await fsp.readFile(path.join(root, 'outside.txt'), 'utf8'), 'outside');
  assert.deepEqual(await names(root), ['outside.txt', '자료', '자료.zip']);
});

archiveTest('keepBoth preserves existing directories, files, and broken symbolic links', async (t) => {
  const root = await fixture(t);
  const zip = await writeZip(root);
  await fsp.mkdir(path.join(root, 'archive'));
  await fsp.writeFile(path.join(root, 'archive/previous.txt'), 'previous directory');
  await fsp.writeFile(path.join(root, 'archive copy'), 'previous file');
  await fsp.symlink('missing', path.join(root, 'archive copy 2'));
  const output = await archiveWithCommands().extract(zip);
  assert.equal(output, path.join(root, 'archive copy 3'));
  assert.equal(await fsp.readFile(path.join(output, 'item.txt'), 'utf8'), 'new contents');
  assert.equal(await fsp.readFile(path.join(root, 'archive/previous.txt'), 'utf8'), 'previous directory');
  assert.equal(await fsp.readFile(path.join(root, 'archive copy'), 'utf8'), 'previous file');
  assert.equal(await fsp.readlink(path.join(root, 'archive copy 2')), 'missing');
  assert.deepEqual(await names(root), ['archive', 'archive copy', 'archive copy 2', 'archive copy 3', 'archive.zip']);
});

archiveTest('an archive modified during snapshot creation is rejected and preserved', async (t) => {
  const root = await fixture(t);
  const zip = await writeZip(root);
  const replacement = storedZip([{ name: 'item.txt', data: 'changed data' }]);
  const archive = archiveWithCommands({
    async afterClone() { await fsp.writeFile(zip, replacement); },
  });
  await assert.rejects(archive.extract(zip), { code: 'FS_CHANGED' });
  assert.deepEqual(await fsp.readFile(zip), replacement);
  assert.deepEqual(await names(root), ['archive.zip']);
});

archiveTest('a selected ZIP symlink is snapshotted as independent contents', async (t) => {
  const root = await fixture(t);
  const target = await writeZip(root, 'target.zip');
  const selected = path.join(root, 'selected.zip');
  await fsp.symlink('target.zip', selected);
  let snapshot;
  const archive = archiveWithCommands({
    async afterClone({ source, destination }) {
      assert.equal(source, target);
      assert.equal((await fsp.lstat(destination)).isFile(), true);
      assert.notEqual((await fsp.stat(destination)).ino, (await fsp.stat(target)).ino);
      assert.deepEqual(await fsp.readFile(destination), await fsp.readFile(target));
      snapshot = destination;
    },
    beforeExtract({ source }) { assert.equal(source, snapshot); },
  });
  const output = await archive.extract(selected);
  assert.equal(output, path.join(root, 'selected'));
  assert.equal(await fsp.readFile(path.join(output, 'item.txt'), 'utf8'), 'new contents');
  assert.equal(archive.commands.find((call) => call.command === '/usr/bin/unzip').args.at(-1), snapshot);
  assert.equal(await fsp.readlink(selected), 'target.zip');
  assert.deepEqual(await names(root), ['selected', 'selected.zip', 'target.zip']);
});

archiveTest('retargeting the selected ZIP symlink cancels extraction', async (t) => {
  const root = await fixture(t);
  await writeZip(root, 'first.zip');
  await writeZip(root, 'second.zip', [{ name: 'other.txt', data: 'other contents' }]);
  const selected = path.join(root, 'selected.zip');
  await fsp.symlink('first.zip', selected);
  const archive = archiveWithCommands({
    async afterClone() {
      await fsp.unlink(selected);
      await fsp.symlink('second.zip', selected);
    },
  });
  await assert.rejects(archive.extract(selected), { code: 'FS_CHANGED' });
  assert.equal(await fsp.readlink(selected), 'second.zip');
  assert.deepEqual(await names(root), ['first.zip', 'second.zip', 'selected.zip']);
});

archiveTest('a source modified after validation cannot publish a stale extraction', async (t) => {
  const root = await fixture(t);
  const zip = await writeZip(root);
  const replacement = storedZip([{ name: 'updated.txt', data: 'updated contents' }]);
  const archive = archiveWithCommands({
    async beforeExtract() { await fsp.writeFile(zip, replacement); },
  });
  await assert.rejects(archive.extract(zip), { code: 'FS_CHANGED' });
  assert.deepEqual(await fsp.readFile(zip), replacement);
  assert.deepEqual(await names(root), ['archive.zip']);
});

for (const filename of ['.zip', '..zip', '...zip']) {
  archiveTest(`archive name ${filename} cannot select its parent as the extraction destination`, async (t) => {
    const root = await fixture(t);
    const zip = await writeZip(root, filename);
    const output = await archiveWithCommands().extract(zip);
    assert.equal(path.dirname(output), root);
    assert.notEqual(output, root);
    assert.equal(await fsp.readFile(path.join(output, 'item.txt'), 'utf8'), 'new contents');
    assert.deepEqual(await names(root), [filename, path.basename(output)].sort());
  });
}

archiveTest('parent and absolute ZIP member paths do not overwrite external files', async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, 'outside.txt');
  await fsp.writeFile(outside, 'outside original');
  const zip = await writeZip(root, 'paths.zip', [
    { name: '../outside.txt', data: 'parent traversal' },
    { name: outside, data: 'absolute traversal' },
  ]);
  let output;
  try { output = await archiveWithCommands().extract(zip); } catch { /* Safe rejection is also valid. */ }
  assert.equal(await fsp.readFile(outside, 'utf8'), 'outside original');
  assert.deepEqual(await names(root), ['outside.txt', 'paths.zip', ...(output ? [path.basename(output)] : [])].sort());
});

archiveTest('conflicting symlink members cannot escape the workspace or leave partial output', async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, 'outside');
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'victim.txt'), 'outside original');
  const zip = await writeZip(root, 'pivot.zip', [
    { name: 'pivot', data: '../../outside', mode: 0o120777 },
    { name: 'pivot/victim.txt', data: 'attempted overwrite' },
  ]);
  await assert.rejects(archiveWithCommands().extract(zip));
  assert.equal(await fsp.readFile(path.join(outside, 'victim.txt'), 'utf8'), 'outside original');
  assert.deepEqual(await names(root), ['outside', 'pivot.zip']);
});

test('native ditto preserves quarantine through ZIP snapshot and final publication', {
  skip: process.platform !== 'darwin' || !hasTools || !executable('/usr/bin/xattr')
    ? 'macOS ditto and xattr required' : false,
}, async (t) => {
  const root = await fixture(t);
  const zip = await writeZip(root);
  const quarantine = '0081;66a00000;MacExplorerTest;TEST-ARCHIVE-QUARANTINE';
  await execFileP('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, zip]);
  const archive = archiveWithCommands({
    async afterClone({ destination }) {
      const { stdout } = await execFileP('/usr/bin/xattr', ['-p', 'com.apple.quarantine', destination]);
      assert.equal(stdout.trimEnd(), quarantine);
    },
  });
  const output = await archive.extract(zip);
  const { stdout } = await execFileP('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path.join(output, 'item.txt')]);
  assert.match(stdout, /TEST-ARCHIVE-QUARANTINE/);
  assert.equal((await execFileP('/usr/bin/xattr', ['-p', 'com.apple.quarantine', zip])).stdout.trimEnd(), quarantine);
  assert.deepEqual(await names(root), ['archive', 'archive.zip']);
});
