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
const { compress } = require('../electron/archive.cjs');

const execFileP = promisify(execFile);
const archivePath = path.resolve(__dirname, '../electron/archive.cjs');
const archiveRequire = createRequire(archivePath);
const hasZipTools = ['/usr/bin/zip', '/usr/bin/unzip'].every((file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
});
const zipTest = (name, fn) => test(name, { skip: !hasZipTools && 'zip/unzip commands unavailable' }, fn);

function loadArchive(overrides = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(archivePath, 'utf8');
  const evaluate = vm.runInThisContext(`(function (require, module, exports) {\n${source}\n})`, {
    filename: archivePath,
  });
  evaluate((name) => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    return archiveRequire(name);
  }, module, module.exports);
  return module.exports;
}

async function fixture(t) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-archive-test-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function members(archive) {
  const { stdout } = await execFileP('/usr/bin/unzip', ['-Z1', archive]);
  return stdout.trimEnd().split('\n');
}

async function contents(archive, member) {
  const { stdout } = await execFileP('/usr/bin/unzip', ['-p', archive, member]);
  return stdout;
}

zipTest('archives same-named files from different folders under their common parent', async (t) => {
  const root = await fixture(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  await fsp.mkdir(a);
  await fsp.mkdir(b);
  await fsp.writeFile(path.join(a, 'same.txt'), 'first contents');
  await fsp.writeFile(path.join(b, 'same.txt'), 'second contents');
  const archive = await compress([path.join(a, 'same.txt'), path.join(b, 'same.txt')]);
  assert.equal(archive, path.join(a, '보관.zip'));
  assert.deepEqual((await members(archive)).sort(), ['a/same.txt', 'b/same.txt']);
  assert.equal(await contents(archive, 'a/same.txt'), 'first contents');
  assert.equal(await contents(archive, 'b/same.txt'), 'second contents');
});

zipTest('single-file compression keeps the original basename and archive naming', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'notes.txt');
  await fsp.writeFile(source, 'notes');
  const archive = await compress([source]);
  assert.equal(archive, source + '.zip');
  assert.deepEqual(await members(archive), ['notes.txt']);
  assert.equal(await contents(archive, 'notes.txt'), 'notes');
});

zipTest('same-folder compression keeps entries at the archive root', async (t) => {
  const root = await fixture(t);
  const first = path.join(root, 'one.txt');
  const second = path.join(root, 'two.txt');
  await fsp.writeFile(first, 'one');
  await fsp.writeFile(second, 'two');
  const archive = await compress([first, second]);
  assert.deepEqual((await members(archive)).sort(), ['one.txt', 'two.txt']);
});

zipTest('filenames containing spaces, leading dashes, and wildcards remain literal', async (t) => {
  const root = await fixture(t);
  const names = ['with spaces.txt', '-r', '--', '-', 'literal[1].txt', 'literal1.txt'];
  for (const name of names) await fsp.writeFile(path.join(root, name), name);
  const selected = names.filter((name) => name !== 'literal1.txt');
  const archive = await compress(selected.map((name) => path.join(root, name)));
  assert.deepEqual((await members(archive)).sort(), [...selected].sort());
  for (const name of selected.filter((name) => !name.includes('['))) {
    assert.equal(await contents(archive, name), name);
  }
});

zipTest('single leading-dash filename is compressed without becoming an option', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, '-r');
  await fsp.writeFile(source, 'literal option-like filename');
  const archive = await compress([source]);
  assert.equal(archive, source + '.zip');
  assert.deepEqual(await members(archive), ['-r']);
  assert.equal(await contents(archive, '-r'), 'literal option-like filename');
});

zipTest('existing ZIP files and broken links are preserved when installing an archive', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'item.txt');
  const existing = source + '.zip';
  const occupied = path.join(root, 'item.txt copy.zip');
  await fsp.writeFile(source, 'new contents');
  await fsp.writeFile(existing, 'existing archive data');
  await fsp.symlink('missing', occupied);
  const archive = await compress([source]);
  assert.equal(archive, path.join(root, 'item.txt copy 2.zip'));
  assert.equal(await fsp.readFile(existing, 'utf8'), 'existing archive data');
  assert.equal(await fsp.readlink(occupied), 'missing');
  assert.equal(await contents(archive, 'item.txt'), 'new contents');
});

zipTest('overlapping selections do not include the temporary archive or its workspace', async (t) => {
  const root = await fixture(t);
  const folder = path.join(root, 'folder');
  const source = path.join(folder, 'item.txt');
  await fsp.mkdir(folder);
  await fsp.writeFile(source, 'contents');
  // Force the preferred temp directory inside the selected folder to exercise fallback.
  const isolated = loadArchive({ os: { ...os, tmpdir: () => folder } });
  const archive = await isolated.compress([source, folder]);
  assert.equal(archive, path.join(folder, '보관.zip'));
  assert.deepEqual((await members(archive)).sort(), ['folder/', 'folder/item.txt']);
  assert.equal(await contents(archive, 'folder/item.txt'), 'contents');
  assert.deepEqual((await fsp.readdir(folder)).sort(), ['item.txt', '보관.zip']);
  assert.deepEqual(await fsp.readdir(root), ['folder']);
});

zipTest('directory compression preserves symbolic links instead of following them', async (t) => {
  const root = await fixture(t);
  const folder = path.join(root, 'folder');
  await fsp.mkdir(folder);
  await fsp.writeFile(path.join(root, 'outside.txt'), 'outside contents');
  await fsp.symlink('../outside.txt', path.join(folder, 'link'));
  await fsp.symlink('missing', path.join(folder, 'broken'));
  const archive = await compress([folder]);
  assert.deepEqual((await members(archive)).sort(), ['folder/', 'folder/broken', 'folder/link']);
  assert.equal(await contents(archive, 'folder/link'), '../outside.txt');
  assert.equal(await contents(archive, 'folder/broken'), 'missing');
});

test('a failed zip command removes only its own partial archive workspace', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'item.txt');
  const existing = source + '.zip';
  await fsp.writeFile(source, 'source contents');
  await fsp.writeFile(existing, 'existing archive');
  let staged;
  const isolated = loadArchive({
    child_process: {
      execFile(_command, args, _options, callback) {
        staged = args[args.indexOf('--') - 1];
        fsp.writeFile(staged, 'partial ZIP data').then(
          () => callback(Object.assign(new Error('Injected zip failure'), { code: 18 }), '', ''),
          (err) => callback(err, '', ''),
        );
      },
    },
  });
  await assert.rejects(isolated.compress([source]), { code: 18 });
  await assert.rejects(fsp.lstat(path.dirname(staged)), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(source, 'utf8'), 'source contents');
  assert.equal(await fsp.readFile(existing, 'utf8'), 'existing archive');
  assert.deepEqual((await fsp.readdir(root)).sort(), ['item.txt', 'item.txt.zip']);
});

zipTest('a successful zip command cannot publish an archive with damaged contents', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'item.txt');
  const existing = source + '.zip';
  await fsp.writeFile(source, 'intact source contents');
  await fsp.writeFile(existing, 'existing archive');
  let staged;
  const isolated = loadArchive({ child_process: {
    execFile(command, args, options, callback) {
      return execFile(command, args, options, (err, stdout, stderr) => {
        if (err || command !== '/usr/bin/zip') return callback(err, stdout, stderr);
        staged = args[args.indexOf('--') - 1];
        (async () => {
          const bytes = await fsp.readFile(staged);
          const dataOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
          bytes[dataOffset] ^= 1;
          await fsp.writeFile(staged, bytes);
        })().then(() => callback(null, stdout, stderr), callback);
      });
    },
  } });
  await assert.rejects(isolated.compress([source]), { code: 'INVALID_ARCHIVE' });
  await assert.rejects(fsp.lstat(path.dirname(staged)), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(existing, 'utf8'), 'existing archive');
  assert.equal(await fsp.readFile(source, 'utf8'), 'intact source contents');
  assert.deepEqual((await fsp.readdir(root)).sort(), ['item.txt', 'item.txt.zip']);
});

zipTest('compression refuses a source changed while zip was reading it', async (t) => {
  const root = await fixture(t);
  const folder = path.join(root, 'folder');
  const source = path.join(folder, 'item.txt');
  await fsp.mkdir(folder);
  await fsp.writeFile(source, 'before compression');
  let staged;
  const isolated = loadArchive({ child_process: {
    execFile(command, args, options, callback) {
      return execFile(command, args, options, (err, stdout, stderr) => {
        if (err || command !== '/usr/bin/zip') return callback(err, stdout, stderr);
        staged = args[args.indexOf('--') - 1];
        // This leaves the ZIP valid; only the source comparison can detect the race.
        fsp.writeFile(source, 'changed during compression').then(
          () => callback(null, stdout, stderr), callback,
        );
      });
    },
  } });
  await assert.rejects(isolated.compress([folder]), { code: 'FS_CHANGED' });
  await assert.rejects(fsp.lstat(path.dirname(staged)), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(source, 'utf8'), 'changed during compression');
  assert.deepEqual(await fsp.readdir(root), ['folder']);
});

test('missing inputs fail without creating an incomplete archive', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'item.txt');
  await fsp.writeFile(source, 'contents');
  await assert.rejects(compress([source, path.join(root, 'missing')]), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readdir(root), ['item.txt']);
});

test('empty selections fail before creating a workspace', async () => {
  await assert.rejects(compress([]), /압축할 항목/);
});
