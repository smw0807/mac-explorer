const path = require('path');
const { randomUUID } = require('crypto');
const { captureSnapshot, sameEntry, changedError } = require('./file-snapshot.cjs');

function sameSnapshot(expected, actual) {
  if (!expected || !actual) return false;
  const names = Object.keys(expected.entries).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(actual.entries).sort())) return false;
  return names.every((name) => {
    const entry = expected.entries[name];
    // Creating and then undoing a child changes directory timestamps. Exact
    // children and every file/link fingerprint must still match before Undo.
    const ignored = entry.type === 'directory' ? ['size', 'mtimeNs', 'ctimeNs'] : [];
    return sameEntry(entry, actual.entries[name], ignored);
  });
}

function createUndoRegistry({ moveItem, trashItem }) {
  const tokens = new Map();
  const entities = new Set();
  const watched = new WeakSet();

  function forget(token) {
    const record = tokens.get(token);
    if (!record) return;
    tokens.delete(token);
    record.entity.tokens.delete(token);
    if (!record.entity.tokens.size && !record.entity.busy) entities.delete(record.entity);
  }

  function watch(owner) {
    if (watched.has(owner)) return;
    watched.add(owner);
    owner.once('destroyed', () => {
      for (const [token, record] of tokens) if (record.owner === owner) forget(token);
    });
  }

  function inherited(owner, source, snapshot) {
    return [...entities].find((entity) => entity.owner === owner && !entity.busy
      && entity.path === source && sameSnapshot(entity.snapshot, snapshot));
  }

  function record(owner, action, metadata) {
    if (owner.isDestroyed() || !metadata?.snapshot) return null;
    watch(owner);
    let entity = action === 'move' ? inherited(owner, metadata.source, metadata.sourceSnapshot) : null;
    if (!entity) {
      entity = { owner, path: metadata.source, snapshot: metadata.sourceSnapshot,
        revision: randomUUID(), tokens: new Set(), busy: false };
      entities.add(entity);
    }
    const beforeRevision = entity.revision;
    const afterRevision = randomUUID();
    const token = randomUUID();
    tokens.set(token, { owner, entity, action, beforePath: metadata.source, beforeRevision, afterRevision });
    entity.tokens.add(token);
    entity.path = metadata.dest;
    entity.snapshot = metadata.snapshot;
    entity.revision = afterRevision;
    return { path: metadata.dest, token };
  }

  function restored(owner, metadata) {
    for (const entity of entities) {
      if (entity.owner === owner && entity.path === metadata.source
        && sameSnapshot(entity.snapshot, metadata.sourceSnapshot)) entity.snapshot = metadata.snapshot;
    }
  }

  async function undo(owner, token) {
    const record = tokens.get(token);
    if (!record || record.owner !== owner) return { ok: false, dirs: [], error: '사용할 수 없는 실행 취소 기록입니다.' };
    const entity = record.entity;
    if (entity.busy) return { ok: false, dirs: [], error: '이 항목을 되돌리는 중입니다.' };
    if (entity.revision !== record.afterRevision) {
      return { ok: false, dirs: [], error: '이 항목의 이후 작업을 먼저 되돌려주세요.' };
    }
    // Acquire synchronously before the first await, including direct IPC callers.
    entity.busy = true;
    const dirs = new Set([path.dirname(entity.path)]);
    let metadata;
    try {
      const current = await captureSnapshot(entity.path);
      if (!sameSnapshot(entity.snapshot, current)) throw changedError(entity.path);
      if (record.action === 'remove') {
        await trashItem(entity.path);
        entity.snapshot = null;
      } else {
        dirs.add(path.dirname(record.beforePath));
        await moveItem(entity.path, path.dirname(record.beforePath), {
          name: path.basename(record.beforePath),
          validateSource(source, snapshot) {
            if (source !== entity.path || !sameSnapshot(entity.snapshot, snapshot)) throw changedError(source);
          },
          onCommitted(value) { metadata = value; },
          onRestored(value) { restored(owner, value); },
        });
        entity.path = metadata?.dest || record.beforePath;
        // A completed inverse without metadata is consumed, but older receipts
        // remain invalid rather than adopting an unverified current filesystem.
        entity.snapshot = metadata?.snapshot || null;
      }
      entity.revision = record.beforeRevision;
      forget(token);
      return { ok: true, dirs: [...dirs] };
    } catch (err) {
      if (err.committedDest) {
        dirs.add(path.dirname(err.committedDest));
        if (metadata?.sourceStaged) {
          entity.path = metadata.dest;
          entity.snapshot = metadata.snapshot;
          entity.revision = record.beforeRevision;
          forget(token);
          return { ok: true, dirs: [...dirs], warning: err.message };
        }
      }
      return { ok: false, dirs: [...dirs], error: err.message || String(err) };
    } finally {
      entity.busy = false;
      if (!entity.tokens.size) entities.delete(entity);
    }
  }

  function release(owner, requested) {
    for (const token of requested) {
      const record = tokens.get(token);
      if (record && record.owner !== owner) throw new Error('다른 창의 실행 취소 기록입니다.');
    }
    for (const token of requested) forget(token);
  }

  return {
    recordCreate: (owner, metadata) => record(owner, 'remove', metadata),
    recordMove: (owner, metadata) => record(owner, 'move', metadata),
    restored, undo, release,
  };
}

module.exports = { createUndoRegistry, sameSnapshot };
