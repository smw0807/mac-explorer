const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  captureSnapshot, assertSnapshot, removeVerifiedSnapshot, captureEntry, assertEntry, changedError, entryFromStat, sameEntry,
} = require('./file-snapshot.cjs');

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

async function copyTree(src, dest, { job, report, sourceSnapshot, relative = '' } = {}) {
  checkCanceled(job);
  const captured = await captureEntry(src);
  const entry = sourceSnapshot?.entries[relative] ?? captured.entry;
  await assertEntry(src, entry);
  const atime = Number(sourceSnapshot?.timestamps[relative]?.atimeNs ?? captured.atimeNs) / 1e9;
  const mtime = Number(entry.mtimeNs) / 1e9;
  if (entry.type === 'symlink') {
    await fsp.symlink(entry.target, dest);
    await fsp.lutimes(dest, atime, mtime);
  } else if (entry.type === 'directory') {
    await fsp.mkdir(dest, { mode: 0o700 });
    for (const name of entry.children) {
      await copyTree(path.join(src, name), path.join(dest, name), {
        job, report, sourceSnapshot, relative: path.join(relative, name),
      });
    }
  } else if (entry.type === 'file') {
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
  await assertEntry(src, entry);
  if (entry.type !== 'symlink') {
    await fsp.chmod(dest, Number(entry.mode) & 0o7777);
    await fsp.utimes(dest, atime, mtime);
  }
}

// Serialize validation and replacement; concurrent copies can still stage in parallel.
let commitTail = Promise.resolve();
async function withCommitLock(fn) {
  const previous = commitTail;
  let release;
  commitTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await fn(); } finally { release(); }
}

async function assertUnchanged(root, snapshot, label, options) {
  try { return await assertSnapshot(root, snapshot, options); }
  catch (err) {
    if (err.code === 'FS_CHANGED') err.message = `작업 중 ${label}이 변경되었습니다: ${err.changedPath}`;
    throw err;
  }
}

async function prepareCommitSnapshot(staged, sourceSnapshot) {
  const snapshot = await captureSnapshot(staged);
  // Snapshot reads can update directory/link atime. Restore it inside the private
  // staging area, then record the ctime produced by our own timestamp restoration.
  for (const relative of Object.keys(snapshot.entries).reverse()) {
    const p = path.join(staged, relative);
    const entry = snapshot.entries[relative];
    const atimeNs = sourceSnapshot.timestamps[relative]?.atimeNs ?? snapshot.timestamps[relative].atimeNs;
    const before = await fsp.lstat(p, { bigint: true });
    const accessDelta = before.atimeNs - BigInt(atimeNs);
    if (accessDelta >= -2000n && accessDelta <= 2000n) continue;
    await assertEntry(p, entry);
    const update = entry.type === 'symlink' ? fsp.lutimes : fsp.utimes;
    await update(p, Number(atimeNs) / 1e9, Number(entry.mtimeNs) / 1e9);
    const after = entryFromStat(await fsp.lstat(p, { bigint: true }));
    const current = { ...entry, ...after };
    // utimes uses floating-point seconds and may round sub-microsecond mtime.
    const delta = BigInt(current.mtimeNs) - BigInt(entry.mtimeNs);
    // APFS also lowers birthtime when utimes moves mtime before the creation time.
    const birthtime = BigInt(entry.birthtimeNs) < BigInt(current.mtimeNs) ? entry.birthtimeNs : current.mtimeNs;
    if (!sameEntry(entry, current, ['birthtimeNs', 'mtimeNs', 'ctimeNs']) || delta < -2000n || delta > 2000n
      || (current.birthtimeNs !== entry.birthtimeNs && current.birthtimeNs !== birthtime)) throw changedError(p);
    snapshot.entries[relative] = current;
    snapshot.timestamps[relative] = { atimeNs };
  }
  return snapshot;
}

async function rebaseRenamedRoot(p, snapshot) {
  const root = { ...snapshot.entries[''], ...entryFromStat(await fsp.lstat(p, { bigint: true })) };
  if (!sameEntry(snapshot.entries[''], root, ['ctimeNs'])) throw changedError(p);
  return { ...snapshot, entries: { ...snapshot.entries, '': root } };
}

async function notifyMetadata(callback, metadata) {
  // Metadata consumers must never turn an already completed filesystem mutation
  // into a rollback, or prevent its path from being reported to the caller.
  try { await callback?.(metadata); } catch { /* no unsafe Undo receipt on metadata failure */ }
}

async function cleanupWorkspace(workspace, failure, committedDest) {
  try { await fsp.rm(workspace, { recursive: true, force: true }); }
  catch (cause) {
    const err = failure || new Error('임시 폴더를 정리하지 못했습니다.', { cause });
    err.cleanupPath = workspace;
    err.message += ` 남은 임시 폴더: ${workspace} (${cause.message})`;
    if (committedDest) err.committedDest = committedDest;
    throw err;
  }
}

async function transferItem(src, destDir, opts, moving, writer = copyTree) {
  const plan = await planDestination(src, destDir, opts.conflict, moving, opts.name, opts.protectedDestinations);
  if (!plan) return null;
  const { source, dest, existing } = plan;
  checkCanceled(opts.job);
  const sourceSnapshot = await captureSnapshot(source, { job: opts.job });
  await opts.validateSource?.(source, sourceSnapshot);
  const destinationSnapshot = existing ? await captureSnapshot(dest, { job: opts.job }) : null;
  if (existing && (destinationSnapshot.entries[''].dev !== existing.dev.toString()
    || destinationSnapshot.entries[''].ino !== existing.ino.toString())) throw changedError(dest);
  const workspace = await fsp.mkdtemp(path.join(path.dirname(dest), '.mac-explorer-'));
  const staged = path.join(workspace, 'new');
  const backup = path.join(workspace, 'previous');
  let sourceStaged = false;
  let committed = false;
  let preserveWorkspace = false;
  let backupPresent = false;
  let backupSnapshot;
  let stagedSnapshot;
  let failure;
  try {
    if (moving) {
      try { await fsp.rename(source, staged); sourceStaged = true; }
      catch (err) { if (err.code !== 'EXDEV') throw err; await writer(source, staged, { ...opts, sourceSnapshot }); }
    } else {
      await writer(source, staged, { ...opts, sourceSnapshot });
    }
    await withCommitLock(async () => {
      checkCanceled(opts.job);
      await assertUnchanged(sourceStaged ? staged : source, sourceSnapshot, '원본', {
        job: opts.job, allowRootRename: sourceStaged,
      });
      if (opts.onCommitted || opts.onRestored) {
        try { stagedSnapshot = await prepareCommitSnapshot(staged, sourceSnapshot); }
        catch { stagedSnapshot = null; }
      }
      if (!sourceStaged) await assertUnchanged(source, sourceSnapshot, '원본', { job: opts.job });
      if (destinationSnapshot) await assertUnchanged(dest, destinationSnapshot, '대상', { job: opts.job });
      else if (await statEntry(dest)) throw Object.assign(changedError(dest), { message: `작업 중 대상이 변경되었습니다: ${dest}` });
      checkCanceled(opts.job);
      try {
        if (existing) {
          await fsp.rename(dest, backup);
          backupPresent = true;
          backupSnapshot = await assertUnchanged(backup, destinationSnapshot, '대상', { allowRootRename: true });
        }
        await fsp.rename(staged, dest);
        committed = true;
      } catch (err) {
        if (backupPresent) {
          try {
            if (await statEntry(dest)) throw new Error('대상 경로가 사용 중입니다.', { cause: err });
            await fsp.rename(backup, dest);
            backupPresent = false;
          } catch (restoreError) {
            preserveWorkspace = true;
            err.message += ` 기존 항목 복구 위치: ${backup} (${restoreError.message})`;
          }
        }
        throw err;
      }
      if (stagedSnapshot) {
        try {
          const snapshot = await rebaseRenamedRoot(dest, stagedSnapshot);
          await notifyMetadata(opts.onCommitted, { source, dest, sourceSnapshot, snapshot, sourceStaged });
        } catch { /* the result remains valid even when no safe Undo snapshot is available */ }
      }
    });
    if (backupPresent) {
      try {
        await removeVerifiedSnapshot(backup, backupSnapshot);
        backupPresent = false;
      } catch (err) {
        preserveWorkspace = true;
        err.recoveryPath = backup;
        err.message += ` 이전 대상의 남은 항목 보존 위치: ${backup}`;
        throw err;
      }
    }
    // After commit the destination is the complete copy. Never remove it if source cleanup fails.
    if (moving && !sourceStaged) {
      try { await removeVerifiedSnapshot(source, sourceSnapshot); }
      catch (err) {
        err.retainedPath = source;
        err.message += ` 원본의 남은 항목 보존 위치: ${source}`;
        throw err;
      }
    }
    return dest;
  } catch (err) {
    failure = err;
    if (sourceStaged && !committed) {
      try {
        if (await statEntry(source)) throw new Error('원본 경로가 사용 중입니다.', { cause: err });
        await fsp.rename(staged, source);
        if (opts.onRestored) {
          try {
            const restored = await assertSnapshot(source, stagedSnapshot || sourceSnapshot, { allowRootRename: true });
            await notifyMetadata(opts.onRestored, { source, sourceSnapshot, snapshot: restored });
          } catch { /* an uncertain restoration must not rebase an earlier Undo token */ }
        }
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
    if (!preserveWorkspace && !backupPresent) {
      await cleanupWorkspace(workspace, failure, committed ? dest : null);
    }
  }
}

async function createItem(parent, name, { directory = false, onCommitted } = {}) {
  const dir = await fsp.realpath(parent);
  const workspace = await fsp.mkdtemp(path.join(dir, '.mac-explorer-create-'));
  const staged = path.join(workspace, 'new');
  let installed;
  let failure;
  try {
    if (directory) await fsp.mkdir(staged);
    else await fsp.writeFile(staged, '', { flag: 'wx' });
    installed = await moveItem(staged, dir, { name, conflict: 'keepBoth', onCommitted });
    return installed;
  } catch (err) { failure = err; throw err; }
  finally {
    await cleanupWorkspace(workspace, failure, installed);
  }
}

const copyItem = (src, dir, opts = {}, writer) => transferItem(src, dir, opts, false, writer);
const moveItem = (src, dir, opts = {}, writer) => transferItem(src, dir, opts, true, writer);

module.exports = { statEntry, uniqueDest, copyItem, moveItem, createItem, copyTree, treeSize, cancelError, validateBatch };
