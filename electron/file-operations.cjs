const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');

async function statEntry(p) {
  try { return await fsp.lstat(p); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

async function uniqueDest(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let dest = path.join(dir, name);
  for (let i = 1; await statEntry(dest); i++) {
    dest = path.join(dir, `${base} copy${i > 1 ? ' ' + i : ''}${ext}`);
  }
  return dest;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function planDestination(src, destDir, conflict, moving, name, protectedDestinations = []) {
  src = path.resolve(src);
  const sourceParent = await fsp.realpath(path.dirname(src));
  const source = path.join(sourceParent, path.basename(src));
  const dir = await fsp.realpath(destDir);
  const sourceStat = await fsp.lstat(source);
  const destName = name ?? path.basename(source);
  if (typeof destName !== 'string' || !destName || destName === '.' || destName === '..'
    || destName.includes('/') || destName.includes('\0')) throw new Error('올바른 파일 이름을 입력해주세요.');
  if (sourceStat.isDirectory() && contains(await fsp.realpath(source), dir)) {
    throw new Error('폴더 자신이나 하위 폴더로 복사·이동할 수 없습니다.');
  }
  if (moving && sourceParent === dir && destName === path.basename(source)) return null;
  let dest = path.join(dir, destName);
  if (!moving && sourceParent === dir) dest = await uniqueDest(dir, destName);
  let existing = await statEntry(dest);
  // On case-insensitive volumes, a case-only rename resolves to the source entry.
  // A separately named hard link is still a real conflict and must be preserved.
  if (moving && sourceParent === dir && existing
    && existing.dev === sourceStat.dev && existing.ino === sourceStat.ino
    && !(await fsp.readdir(dir)).includes(destName)) existing = null;
  if (existing) {
    if (conflict === 'skip') return null;
    if (conflict === 'keepBoth') {
      dest = await uniqueDest(dir, destName);
      existing = null;
    } else if (conflict !== 'overwrite') {
      throw new Error(`이미 존재합니다: ${path.basename(source)}`);
    } else {
      for (const previous of protectedDestinations) {
        const protectedStat = await statEntry(previous);
        if (protectedStat && existing.dev === protectedStat.dev && existing.ino === protectedStat.ino) {
          throw new Error('선택한 원본이나 이번 작업에서 이미 처리한 항목을 덮어쓸 수 없습니다.');
        }
      }
    }
  }
  if (existing?.isDirectory() && contains(await fsp.realpath(dest), source)) {
    throw new Error('원본을 포함한 폴더를 덮어쓸 수 없습니다.');
  }
  return { source, dest, existing };
}

async function validateBatch(paths, destDir, opts = {}) {
  const dir = await fsp.realpath(destDir);
  const sources = await Promise.all(paths.map(async (src) =>
    path.join(await fsp.realpath(path.dirname(path.resolve(src))), path.basename(src))));
  // One replacement must never delete another selected source in the same batch.
  if (opts.conflict === 'overwrite') {
    const destinations = new Map();
    for (const source of sources) {
      const dest = path.join(dir, opts.name ?? path.basename(source));
      if (destinations.has(dest) && destinations.get(dest) !== source) {
        throw new Error('선택한 항목들의 대상 이름이 같습니다. 둘 다 유지를 선택해주세요.');
      }
      destinations.set(dest, source);
      if (sources.some((other) => other !== source && other === dest)) {
        throw new Error('선택한 원본을 덮어쓸 수 없습니다.');
      }
      if ((await statEntry(dest))?.isDirectory()) {
        const actual = await fsp.realpath(dest);
        if (sources.some((other) => (other !== source || other !== dest) && contains(actual, other))) {
          throw new Error('선택한 원본을 포함한 폴더를 덮어쓸 수 없습니다.');
        }
      }
    }
  }
}

function cancelError() { return Object.assign(new Error('취소됨'), { canceled: true }); }
function checkCanceled(job) { if (job?.canceled || job?.controller?.signal.aborted) throw cancelError(); }

async function treeSize(src, job) {
  checkCanceled(job);
  const st = await fsp.lstat(src);
  if (!st.isDirectory()) return st.isSymbolicLink() ? 0 : st.size;
  let total = 0;
  for (const name of await fsp.readdir(src)) total += await treeSize(path.join(src, name), job);
  return total;
}

async function copyTree(src, dest, { job, report } = {}) {
  checkCanceled(job);
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(src), dest);
    await fsp.lutimes(dest, st.atime, st.mtime);
  } else if (st.isDirectory()) {
    await fsp.mkdir(dest, { mode: 0o700 });
    for (const name of await fsp.readdir(src)) {
      await copyTree(path.join(src, name), path.join(dest, name), { job, report });
    }
  } else if (st.isFile()) {
    if (report) report.currentFile = src;
    const input = fs.createReadStream(src);
    input.on('data', (chunk) => { if (report) report.copied += chunk.length; });
    try {
      await pipeline(input, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }), { signal: job?.controller?.signal });
    } catch (err) { checkCanceled(job); throw err; }
  } else {
    throw new Error(`지원하지 않는 파일 유형입니다: ${src}`);
  }
  checkCanceled(job);
  if (!st.isSymbolicLink()) {
    await fsp.chmod(dest, st.mode & 0o7777);
    await fsp.utimes(dest, st.atime, st.mtime);
  }
}

// Serialize only the short commit section; concurrent copies can still stage in parallel.
let commitTail = Promise.resolve();
async function withCommitLock(fn) {
  const previous = commitTail;
  let release;
  commitTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await fn(); } finally { release(); }
}

function sameEntry(a, b) {
  return a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size;
}

async function transferItem(src, destDir, opts, moving, writer = copyTree) {
  const plan = await planDestination(src, destDir, opts.conflict, moving, opts.name, opts.protectedDestinations);
  if (!plan) return null;
  const { source, dest, existing } = plan;
  checkCanceled(opts.job);
  const workspace = await fsp.mkdtemp(path.join(path.dirname(dest), '.mac-explorer-'));
  const staged = path.join(workspace, 'new');
  const backup = path.join(workspace, 'previous');
  let sourceStaged = false;
  let committed = false;
  let preserveWorkspace = false;
  try {
    if (moving) {
      try { await fsp.rename(source, staged); sourceStaged = true; }
      catch (err) { if (err.code !== 'EXDEV') throw err; await writer(source, staged, opts); }
    } else {
      await writer(source, staged, opts);
    }
    await withCommitLock(async () => {
      checkCanceled(opts.job);
      if (!sameEntry(existing, await statEntry(dest))) throw new Error(`작업 중 대상이 변경되었습니다: ${dest}`);
      let backedUp = false;
      try {
        if (existing) { await fsp.rename(dest, backup); backedUp = true; }
        await fsp.rename(staged, dest);
        committed = true;
      } catch (err) {
        if (backedUp) {
          try {
            if (await statEntry(dest)) throw new Error('대상 경로가 사용 중입니다.');
            await fsp.rename(backup, dest);
          } catch (restoreError) {
            preserveWorkspace = true;
            err.message += ` 기존 항목 복구 위치: ${backup} (${restoreError.message})`;
          }
        }
        throw err;
      }
    });
    // After commit the destination is the complete copy. Never remove it if source cleanup fails.
    if (moving && !sourceStaged) await fsp.rm(source, { recursive: true });
    return dest;
  } catch (err) {
    if (sourceStaged && !committed) {
      try {
        if (await statEntry(source)) throw new Error('원본 경로가 사용 중입니다.');
        await fsp.rename(staged, source);
      } catch (restoreError) {
        preserveWorkspace = true;
        err.message += ` 원본 복구 위치: ${staged} (${restoreError.message})`;
      }
    }
    if (committed) {
      err.committedDest = dest;
      err.message += ` 완전한 복사본이 보존된 위치: ${dest}`;
    }
    throw err;
  } finally {
    if (!preserveWorkspace) await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

const copyItem = (src, dir, opts = {}, writer) => transferItem(src, dir, opts, false, writer);
const moveItem = (src, dir, opts = {}, writer) => transferItem(src, dir, opts, true, writer);

module.exports = { statEntry, uniqueDest, copyItem, moveItem, copyTree, treeSize, cancelError, validateBatch };
