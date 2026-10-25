const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { moveItem } = require('./file-operations.cjs');

const execFileP = promisify(execFile);

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
  const directories = sources.filter((source) => source.stat.isDirectory()).map((source) => source.path);
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
    sources.push({ path: source, stat: await fsp.lstat(source) });
  }
  const cwd = commonParent(sources.map((source) => source.path));
  const outputDir = path.dirname(sources[0].path);
  const archiveName = (sources.length === 1 ? path.basename(sources[0].path) : '보관') + '.zip';
  const workspace = await createWorkspace(sources, cwd, outputDir);
  const staged = path.join(workspace, archiveName);
  try {
    const members = sources.map((source) => '.' + path.sep + path.relative(cwd, source.path));
    // -MM rejects unreadable/missing inputs; -nw and -- treat names literally.
    await execFileP('/usr/bin/zip', ['-q', '-r', '-y', '-MM', '-nw', staged, '--', ...members],
      { cwd, maxBuffer: 64 * 1024 * 1024 });
    return await moveItem(staged, outputDir, { conflict: 'keepBoth' });
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { compress };
