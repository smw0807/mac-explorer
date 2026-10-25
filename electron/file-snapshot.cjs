const fsp = require('fs/promises');
const path = require('path');

const fields = ['type', 'dev', 'ino', 'mode', 'size', 'nlink', 'birthtimeNs', 'mtimeNs', 'ctimeNs'];

function checkCanceled(job) {
  if (job?.canceled || job?.controller?.signal.aborted) {
    throw Object.assign(new Error('취소됨'), { canceled: true });
  }
}

function changedError(p) {
  return Object.assign(new Error(`작업 중 항목이 변경되었습니다: ${p}`), { code: 'FS_CHANGED', changedPath: p });
}

function entryFromStat(st) {
  const entry = { type: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other' };
  for (const field of fields.slice(1)) entry[field] = st[field].toString();
  return entry;
}

function sameEntry(a, b, ignored = []) {
  return fields.every((field) => ignored.includes(field) || a[field] === b[field])
    && a.target === b.target
    && JSON.stringify(a.children) === JSON.stringify(b.children);
}

// Capture a single entry without following links. Access time is preservation metadata,
// not identity: reading a file, directory, or link may update it during our own work.
async function captureEntry(p) {
  try {
    const st = await fsp.lstat(p, { bigint: true });
    const entry = entryFromStat(st);
    if (entry.type === 'symlink') entry.target = await fsp.readlink(p);
    if (entry.type === 'directory') entry.children = (await fsp.readdir(p)).sort();
    const after = entryFromStat(await fsp.lstat(p, { bigint: true }));
    if (!fields.every((field) => entry[field] === after[field])) throw changedError(p);
    return { entry, atimeNs: st.atimeNs.toString() };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw changedError(p);
    throw err;
  }
}

async function assertEntry(p, expected, ignored = []) {
  const { entry } = await captureEntry(p);
  if (!sameEntry(expected, entry, ignored)) throw changedError(p);
  return entry;
}

async function captureSnapshot(root, { job } = {}) {
  const entries = Object.create(null);
  const timestamps = Object.create(null);
  async function visit(relative) {
    checkCanceled(job);
    const p = path.join(root, relative);
    const { entry, atimeNs } = await captureEntry(p);
    entries[relative] = entry;
    timestamps[relative] = { atimeNs };
    if (entry.type === 'directory') {
      for (const name of entry.children) await visit(path.join(relative, name));
      await assertEntry(p, entry);
    }
  }
  await visit('');
  return { version: 1, entries, timestamps };
}

async function assertSnapshot(root, expected, { job, allowRootRename = false } = {}) {
  const actual = await captureSnapshot(root, { job });
  const expectedPaths = Object.keys(expected.entries).sort();
  const actualPaths = Object.keys(actual.entries).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) throw changedError(root);
  for (const relative of expectedPaths) {
    // A rename changes only the moved root's ctime, including on macOS/APFS.
    const ignored = allowRootRename && relative === '' ? ['ctimeNs'] : [];
    if (!sameEntry(expected.entries[relative], actual.entries[relative], ignored)) {
      throw changedError(path.join(root, relative));
    }
  }
  return actual;
}

async function removeVerifiedSnapshot(root, expected, { job } = {}) {
  const verified = await assertSnapshot(root, expected, { job });
  const remaining = new Map(Object.entries(verified.entries));
  let removedCount = 0;

  async function assertAncestors(relative) {
    const parents = [];
    while (relative !== '') {
      const parent = path.dirname(relative);
      relative = parent === '.' ? '' : parent;
      parents.unshift(relative);
    }
    for (const parent of parents) await assertEntry(path.join(root, parent), remaining.get(parent));
  }

  async function updateParent(relative) {
    if (relative === '') return;
    const dirname = path.dirname(relative);
    const parent = dirname === '.' ? '' : dirname;
    const before = remaining.get(parent);
    const expectedParent = { ...before, children: before.children.filter((name) => name !== path.basename(relative)) };
    // Removing a known child changes the directory's size, link count, and timestamps.
    // Its identity, permissions, and exact remaining names must still match.
    const current = await assertEntry(path.join(root, parent), expectedParent, ['size', 'nlink', 'mtimeNs', 'ctimeNs']);
    remaining.set(parent, current);
  }

  async function updateHardlinks(removed) {
    if (removed.type === 'directory' || BigInt(removed.nlink) <= 1n) return;
    const aliases = [...remaining].filter(([, entry]) => entry.dev === removed.dev && entry.ino === removed.ino);
    if (!aliases.length) return;
    const [relative, before] = aliases[0];
    await assertAncestors(relative);
    const expectedAlias = { ...before, nlink: (BigInt(before.nlink) - 1n).toString() };
    // Our unlink changes ctime on every remaining hardlink to this inode.
    const current = await assertEntry(path.join(root, relative), expectedAlias, ['ctimeNs']);
    for (const [alias, entry] of aliases) remaining.set(alias, { ...entry, nlink: current.nlink, ctimeNs: current.ctimeNs });
  }

  async function remove(relative) {
    checkCanceled(job);
    const p = path.join(root, relative);
    await assertAncestors(relative);
    const entry = await assertEntry(p, remaining.get(relative));
    if (entry.type === 'directory') {
      for (const name of entry.children) await remove(path.join(relative, name));
      checkCanceled(job);
      await assertAncestors(relative);
      await assertEntry(p, remaining.get(relative));
      // Never use recursive rm here: a newly created child must survive.
      await fsp.rmdir(p);
    } else {
      await fsp.unlink(p);
    }
    remaining.delete(relative);
    removedCount++;
    await updateParent(relative);
    await updateHardlinks(entry);
  }

  try {
    await remove('');
    return { removedCount };
  } catch (err) {
    err.retainedPath = root;
    err.removedCount = removedCount;
    throw err;
  }
}

module.exports = { captureSnapshot, assertSnapshot, removeVerifiedSnapshot, captureEntry, assertEntry, entryFromStat, sameEntry, changedError };
