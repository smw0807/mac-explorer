const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { moveItem } = require('./file-operations.cjs');
const { captureSnapshot, assertSnapshot, changedError } = require('./file-snapshot.cjs');

const execFileP = promisify(execFile);

function commandOptions(options = {}) {
  const env = { ...process.env };
  // User shell defaults must not weaken CRC checks or change link/metadata handling.
  for (const name of ['ZIPOPT', 'UNZIP', 'UNZIPOPT', 'ZIPINFO', 'ZIPINFOOPT', 'DITTONORSRC']) delete env[name];
  return { maxBuffer: 64 * 1024 * 1024, ...options, env };
}

async function validateArchive(archive) {
  try {
    // An explicit empty password makes encrypted inputs fail without an interactive prompt.
    await execFileP('/usr/bin/unzip', ['-tq', '-P', '', archive], commandOptions());
  } catch (cause) {
    throw Object.assign(new Error('ZIP 무결성 검증에 실패했습니다. 손상되었거나 암호로 보호된 파일인지 확인해주세요.', { cause }), {
      code: 'INVALID_ARCHIVE',
    });
  }
}

async function cleanupWorkspace(workspace, failure, installed) {
  try {
    await fsp.rm(workspace, { recursive: true, force: true });
  } catch (cause) {
    const error = failure || new Error('임시 폴더를 정리하지 못했습니다.', { cause });
    error.cleanupPath = workspace;
    error.message += ` 남은 임시 폴더: ${workspace} (${cause.message})`;
    if (installed) {
      error.committedDest = installed;
      error.message += ` 완료된 결과 위치: ${installed}`;
    }
    throw error;
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function commonParent(paths) {
  let parent = path.dirname(paths[0]);
  for (const source of paths.slice(1)) {
    const dir = path.dirname(source);
    while (!contains(parent, dir)) parent = path.dirname(parent);
  }
  return parent;
}

async function createWorkspace(sources, cwd, outputDir) {
  const directories = sources.filter((source) => source.snapshot.entries[''].type === 'directory').map((source) => source.path);
  const candidates = [...new Set([os.tmpdir(), cwd, outputDir, os.homedir()])];
  let lastError;
  for (const candidate of candidates) {
    try {
      const dir = await fsp.realpath(candidate);
      // A selected directory must never include the archive currently being written.
      if (directories.some((source) => contains(source, dir))) continue;
      return await fsp.mkdtemp(path.join(dir, '.mac-explorer-archive-'));
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error('선택 항목 외부에 압축용 임시 폴더를 만들 수 없습니다.'
    + (lastError ? ` ${lastError.message}` : ''));
}

async function compress(paths) {
  if (!Array.isArray(paths) || paths.length === 0
    || paths.some((source) => typeof source !== 'string' || source.length === 0)) {
    throw new Error('압축할 항목을 선택해주세요.');
  }
  const sources = [];
  const seen = new Set();
  for (const input of paths) {
    const absolute = path.resolve(input);
    // Resolve parent aliases while preserving a selected symbolic link as a link.
    const source = path.join(await fsp.realpath(path.dirname(absolute)), path.basename(absolute));
    if (seen.has(source)) continue;
    seen.add(source);
    await fsp.lstat(source);
    sources.push({ path: source });
  }
  for (const source of sources) source.snapshot = await captureSnapshot(source.path);
  const cwd = commonParent(sources.map((source) => source.path));
  const outputDir = path.dirname(sources[0].path);
  const archiveName = (sources.length === 1 ? path.basename(sources[0].path) : '보관') + '.zip';
  const workspace = await createWorkspace(sources, cwd, outputDir);
  const staged = path.join(workspace, archiveName);
  let failure;
  let installed;
  try {
    const members = sources.map((source) => '.' + path.sep + path.relative(cwd, source.path));
    // -MM rejects unreadable/missing inputs; -nw and -- treat names literally.
    await execFileP('/usr/bin/zip', ['-q', '-r', '-y', '-MM', '-nw', staged, '--', ...members],
      commandOptions({ cwd }));
    await validateArchive(staged);
    for (const source of sources) await assertSnapshot(source.path, source.snapshot);
    installed = await moveItem(staged, outputDir, { conflict: 'keepBoth' });
    return installed;
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    await cleanupWorkspace(workspace, failure, installed);
  }
}

async function extract(zipPath) {
  const input = path.resolve(zipPath);
  const source = await fsp.realpath(input);
  const original = await captureSnapshot(source);
  if (original.entries[''].type !== 'file') throw new Error('압축 해제할 ZIP 파일을 선택해주세요.');
  // Keep a selected link's identity as well as the regular file it currently targets.
  const inputSnapshot = await captureSnapshot(input);
  async function assertOriginal() {
    await assertSnapshot(source, original);
    await assertSnapshot(input, inputSnapshot);
    let resolved;
    try { resolved = await fsp.realpath(input); } catch { throw changedError(input); }
    if (resolved !== source) throw changedError(input);
  }
  await assertOriginal();

  const outputDir = await fsp.realpath(path.dirname(input));
  const basename = path.basename(input).replace(/\.zip$/i, '');
  const name = basename && basename !== '.' && basename !== '..' ? basename : '압축 해제';
  // Sharing the destination filesystem lets the final rename retain ditto's metadata.
  const workspace = await fsp.mkdtemp(path.join(outputDir, '.mac-explorer-extract-'));
  const archive = path.join(workspace, 'input.zip');
  const payload = path.join(workspace, 'payload');
  let failure;
  let installed;
  try {
    // Stream copies drop quarantine on macOS. Clone/copy with ditto preserves it and
    // snapshots the resolved file's contents, rather than copying an input symlink.
    await execFileP('/usr/bin/ditto', ['--clone', '--qtn', source, archive], commandOptions());
    await assertOriginal();
    await validateArchive(archive);
    await execFileP('/usr/bin/ditto', ['-x', '-k', '--qtn', archive, payload], commandOptions());
    if (!(await fsp.lstat(payload)).isDirectory()) throw new Error('압축 해제 결과 폴더를 확인할 수 없습니다.');
    await assertOriginal();
    installed = await moveItem(payload, outputDir, { name, conflict: 'keepBoth' });
    return installed;
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    await cleanupWorkspace(workspace, failure, installed);
  }
}

module.exports = { compress, extract };
