const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');

const compiled = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/settingsSaveQueue.js')],
  bundle: true, write: false, platform: 'node', format: 'cjs',
});
const loaded = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(loaded, loaded.exports);
const { createSettingsSaveQueue } = loaded.exports;
const settle = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('settings debounce saves only the newest complete immutable snapshot after 500ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  const queue = createSettingsSaveQueue({ save: async (value) => { writes.push(value); return { ok: true }; } });
  t.after(() => queue.dispose());
  queue.enqueue({ favorites: [], session: { active: 0 } });
  t.mock.timers.tick(400);
  const latest = { favorites: ['/new'], session: { active: 1 } };
  queue.enqueue(latest);
  latest.favorites.push('/must-not-leak');
  t.mock.timers.tick(499);
  await settle();
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(writes, [{ favorites: ['/new'], session: { active: 1 } }]);
  queue.enqueue({ favorites: ['/new'], session: { active: 1 } });
  t.mock.timers.tick(500);
  await settle();
  assert.equal(writes.length, 1);
  assert.deepEqual(queue.getState(), { dirty: false, saving: false, error: null });
});

test('settings writes serialize and a flush awaits the latest snapshot added during an active write', async () => {
  const first = deferred();
  const last = deferred();
  const writes = [];
  const queue = createSettingsSaveQueue({ save: (value) => { writes.push(value); return writes.length === 1 ? first.promise : last.promise; } });
  queue.enqueue({ version: 1 });
  const saving = queue.flush();
  await settle();
  queue.enqueue({ version: 2 });
  queue.enqueue({ version: 3 });
  assert.equal(queue.flush(), saving);
  assert.deepEqual(writes, [{ version: 1 }]);
  first.resolve({ ok: true });
  await settle();
  assert.deepEqual(writes, [{ version: 1 }, { version: 3 }]);
  let finished = false;
  saving.then(() => { finished = true; });
  await settle();
  assert.equal(finished, false);
  last.resolve({ ok: true });
  assert.deepEqual(await saving, { ok: true });
  assert.equal(queue.getState().dirty, false);
  queue.dispose();
});

test('a snapshot queued between drain completion and promise cleanup is included in the same flush', async () => {
  const writes = [];
  let enqueueAtCompletion = true;
  const queue = createSettingsSaveQueue({
    save: async (value) => { writes.push(value); return { ok: true }; },
    onChange: (state) => {
      if (enqueueAtCompletion && state.saving && !state.dirty) {
        enqueueAtCompletion = false;
        queueMicrotask(() => queue.enqueue({ version: 2 }));
      }
    },
  });
  queue.enqueue({ version: 1 });
  assert.deepEqual(await queue.flush(), { ok: true });
  assert.deepEqual(writes, [{ version: 1 }, { version: 2 }]);
  assert.deepEqual(queue.getState(), { dirty: false, saving: false, error: null });
  queue.dispose();
});

for (const reject of [false, true]) {
  test(`failed settings writes remain dirty without an automatic retry loop (${reject ? 'rejection' : 'failure result'})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const writes = [];
    const queue = createSettingsSaveQueue({ save: async (value) => {
      writes.push(value);
      if (writes.length > 1) return { ok: true };
      if (reject) throw new Error('disk unavailable');
      return { ok: false, error: 'disk unavailable' };
    } });
    t.after(() => queue.dispose());
    queue.enqueue({ version: 1 });
    assert.deepEqual(await queue.flush(), { ok: false, error: 'disk unavailable' });
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(writes.length, 1);
    assert.deepEqual(queue.getState(), { dirty: true, saving: false, error: 'disk unavailable' });
    queue.enqueue({ version: 2 });
    assert.deepEqual(await queue.flush(), { ok: true });
    assert.deepEqual(writes, [{ version: 1 }, { version: 2 }]);
    assert.deepEqual(queue.getState(), { dirty: false, saving: false, error: null });
  });
}

test('disposing clears pending debounce and suppresses follow-up writes and notifications', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  let writes = 0;
  let notices = 0;
  const queue = createSettingsSaveQueue({
    save: () => { writes += 1; return pending.promise; },
    onChange: () => { notices += 1; },
  });
  queue.enqueue({ version: 1 });
  const flushing = queue.flush();
  await settle();
  queue.enqueue({ version: 2 });
  queue.dispose();
  const before = notices;
  queue.enqueue({ version: 3 });
  pending.resolve({ ok: true });
  assert.equal((await flushing).ok, false);
  assert.equal((await queue.flush()).ok, false);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(writes, 1);
  assert.equal(notices, before);

  const delayed = createSettingsSaveQueue({ save: () => assert.fail('disposed debounce must not write') });
  delayed.enqueue({ version: 1 });
  delayed.dispose();
  t.mock.timers.tick(500);
  await settle();
});
