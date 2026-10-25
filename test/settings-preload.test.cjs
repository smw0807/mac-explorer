const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function loadPreload({ invoke = async () => ({ ok: true }) } = {}) {
  const calls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = (channel, ...args) => {
    calls.push({ channel, args });
    return Promise.resolve().then(() => invoke(channel, ...args));
  };
  let api;
  const electron = {
    ipcRenderer,
    contextBridge: {
      exposeInMainWorld(name, exposed) {
        assert.equal(name, 'api');
        api = exposed;
      },
    },
    webUtils: { getPathForFile: () => '' },
  };
  const filename = path.join(__dirname, '../electron/preload.cjs');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return electron;
    },
    console,
  }, { filename });
  const requests = (channel) => calls.filter((call) => call.channel === channel);
  return {
    api,
    ipcRenderer,
    requests,
    flush(requestId, reason = 'close') {
      ipcRenderer.emit('settings:flush', { sender: 'private IPC event' }, { requestId, reason });
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function drain() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertFailure(value) {
  assert.equal(value.ok, false);
  assert.equal(typeof value.error, 'string');
  assert.ok(value.error.length > 0);
  assert.ok(value.error.length <= 4096);
  assert.equal(value.error.includes('\0'), false);
  assert.deepEqual(Object.keys(value).sort(), ['error', 'ok']);
}

test('settings readiness requires a registered flush callback and unsubscribe revokes it', async () => {
  const bridge = loadPreload();
  assertFailure(await bridge.api.settingsReady());
  assert.equal(bridge.requests('settings:ready').some(({ args }) => args[0] === true), false);

  const unsubscribe = bridge.api.onSettingsFlush(async () => ({ ok: true }));
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(bridge.ipcRenderer.listenerCount('settings:flush'), 1);
  assert.deepEqual(plain(await bridge.api.settingsReady()), { ok: true });
  assert.equal(bridge.requests('settings:ready').filter(({ args }) => args[0] === true).length, 1);

  unsubscribe();
  await drain();
  assert.equal(bridge.ipcRenderer.listenerCount('settings:flush'), 0);
  assert.equal(bridge.requests('settings:ready').at(-1).args[0], false);
  assertFailure(await bridge.api.settingsReady());
});

test('flush callback receives only its reason and success produces an automatic minimal ACK', async () => {
  const bridge = loadPreload();
  const received = [];
  bridge.api.onSettingsFlush((...args) => {
    received.push(args);
    return { ok: true, privateValue: 'must not cross IPC' };
  });
  await bridge.api.settingsReady();

  bridge.flush('close-request', 'close');
  bridge.flush('quit-request', 'quit');
  await drain();

  assert.deepEqual(plain(received), [[{ reason: 'close' }], [{ reason: 'quit' }]]);
  assert.deepEqual(plain(bridge.requests('settings:flushResult')), [
    { channel: 'settings:flushResult', args: ['close-request', { ok: true }] },
    { channel: 'settings:flushResult', args: ['quit-request', { ok: true }] },
  ]);
});

test('a repeated request invokes the callback once even while it is pending or after its ACK', async () => {
  const bridge = loadPreload();
  const gate = deferred();
  let count = 0;
  bridge.api.onSettingsFlush(async () => {
    count++;
    return await gate.promise;
  });
  await bridge.api.settingsReady();
  bridge.flush('same-request');
  bridge.flush('same-request');
  await drain();
  assert.equal(count, 1);
  assert.equal(bridge.requests('settings:flushResult').length, 0);

  gate.resolve({ ok: true });
  await drain();
  bridge.flush('same-request');
  await drain();
  assert.equal(count, 1);
  assert.equal(bridge.requests('settings:flushResult').length, 1);

  bridge.flush('new-request');
  await drain();
  assert.equal(count, 2);
  assert.equal(bridge.requests('settings:flushResult').length, 2);
});

test('only an explicit ok true callback result permits closing', async (t) => {
  for (const [label, value] of [
    ['undefined', undefined], ['null', null], ['false', false], ['true', true],
    ['empty object', {}], ['truthy ok', { ok: 1 }],
    ['failure without error', { ok: false }],
    ['failure with error', { ok: false, error: '설정을 저장하지 못했습니다.' }],
  ]) {
    await t.test(label, async () => {
      const bridge = loadPreload();
      bridge.api.onSettingsFlush(() => value);
      await bridge.api.settingsReady();
      bridge.flush('failure-request');
      await drain();
      const [ack] = bridge.requests('settings:flushResult');
      assert.ok(ack);
      assert.equal(ack.args[0], 'failure-request');
      assertFailure(ack.args[1]);
      if (value?.error) assert.equal(ack.args[1].error, value.error);
    });
  }
});

test('thrown and rejected callbacks become bounded error ACKs without leaking Error objects', async (t) => {
  const message = '저장\0실패'.repeat(1200);
  const cases = [
    ['throw Error', () => { throw new Error(message); }],
    ['reject Error', () => Promise.reject(new Error(message))],
    ['reject string', () => Promise.reject(message)],
    ['failure result', () => ({ ok: false, error: message, stack: 'private stack' })],
  ];
  for (const [label, callback] of cases) {
    await t.test(label, async () => {
      const bridge = loadPreload();
      bridge.api.onSettingsFlush(callback);
      await bridge.api.settingsReady();
      bridge.flush('error-request');
      await drain();
      const [ack] = bridge.requests('settings:flushResult');
      assert.ok(ack);
      assertFailure(ack.args[1]);
    });
  }
});

test('unsubscribing suppresses a pending callback ACK and does not handle later requests', async () => {
  const bridge = loadPreload();
  const gate = deferred();
  let count = 0;
  const unsubscribe = bridge.api.onSettingsFlush(async () => {
    count++;
    return await gate.promise;
  });
  await bridge.api.settingsReady();
  bridge.flush('pending-request');
  await drain();
  assert.equal(count, 1);
  unsubscribe();
  gate.resolve({ ok: true });
  bridge.flush('after-unsubscribe');
  await drain();
  assert.equal(count, 1);
  assert.equal(bridge.requests('settings:flushResult').length, 0);
  assert.equal(bridge.requests('settings:ready').at(-1).args[0], false);
});

test('replacing a subscription invalidates old work while old cleanup preserves the new listener', async () => {
  const bridge = loadPreload();
  const gate = deferred();
  let oldCalls = 0;
  let newCalls = 0;
  const oldUnsubscribe = bridge.api.onSettingsFlush(async () => {
    oldCalls++;
    return await gate.promise;
  });
  await bridge.api.settingsReady();
  bridge.flush('shared-request');
  await drain();
  const newUnsubscribe = bridge.api.onSettingsFlush(() => {
    newCalls++;
    return { ok: true };
  });
  assert.equal(bridge.requests('settings:ready').at(-1).args[0], false);
  assert.equal(bridge.ipcRenderer.listenerCount('settings:flush'), 1);
  await bridge.api.settingsReady();
  const readinessCalls = bridge.requests('settings:ready').length;
  oldUnsubscribe();
  oldUnsubscribe();
  assert.equal(bridge.requests('settings:ready').length, readinessCalls);
  assert.equal(bridge.ipcRenderer.listenerCount('settings:flush'), 1);

  gate.resolve({ ok: true });
  await drain();
  assert.equal(bridge.requests('settings:flushResult').length, 0);
  bridge.flush('shared-request');
  await drain();
  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1);
  assert.equal(bridge.requests('settings:flushResult').length, 1);
  newUnsubscribe();
  await drain();
  assert.equal(bridge.ipcRenderer.listenerCount('settings:flush'), 0);
});

test('a rejected stale callback is consumed after unsubscribe without an ACK', async () => {
  const bridge = loadPreload();
  const gate = deferred();
  const unsubscribe = bridge.api.onSettingsFlush(async () => {
    await gate.promise;
    throw new Error('stale failure');
  });
  await bridge.api.settingsReady();
  bridge.flush('stale-rejection');
  await drain();
  unsubscribe();
  gate.resolve();
  await drain();
  assert.equal(bridge.requests('settings:flushResult').length, 0);
});

test('cleanup and ACK transport rejections are consumed rather than becoming unhandled rejections', async () => {
  const bridge = loadPreload({ invoke: async (channel, ...args) => {
    if (channel === 'settings:flushResult' || (channel === 'settings:ready' && args[0] === false)) {
      throw new Error('renderer is closing');
    }
    return { ok: true };
  } });
  const unsubscribe = bridge.api.onSettingsFlush(() => ({ ok: true }));
  await bridge.api.settingsReady();
  bridge.flush('transport-rejection');
  await drain();
  assert.equal(bridge.requests('settings:flushResult').length, 1);
  unsubscribe();
  await drain();
  assert.equal(bridge.requests('settings:ready').at(-1).args[0], false);
  assert.equal(bridge.ipcRenderer.listenerCount('settings:flush'), 0);
});
