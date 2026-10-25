const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const operations = require('../electron/file-operations.cjs');
const { loadMain } = require('./helpers/main.cjs');

for (const canceled of [false, true]) {
  test(`copy terminal event retains completed items after ${canceled ? 'cancel' : 'error'}`, async (t) => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-ipc-')));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const destDir = path.join(root, 'dest');
    await fsp.mkdir(destDir);
    const inputs = ['first', 'second'].map((name) => path.join(root, name));
    for (const input of inputs) await fsp.writeFile(input, 'contents');
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const api = loadMain({
      onSend: (_channel, data) => { if (data.done) finish(data); },
      overrides: { './file-operations.cjs': {
        ...operations,
        async copyItem(src, dir, opts) {
          if (src === inputs[1]) throw new Error('injected failure');
          const result = await operations.copyItem(src, dir, opts);
          if (canceled) { opts.job.canceled = true; opts.job.controller.abort(); }
          return result;
        },
      } },
    });
    const start = api.invoke('fs:copyStart', inputs, destDir);
    const terminal = await done;
    assert.equal(terminal.jobId, start.jobId);
    assert.equal(terminal.destDir, destDir);
    assert.deepEqual(terminal.created, [path.join(destDir, 'first')]);
    assert.equal(!!terminal.canceled, canceled);
    assert.equal(await fsp.readFile(path.join(destDir, 'first'), 'utf8'), 'contents');
  });
}
