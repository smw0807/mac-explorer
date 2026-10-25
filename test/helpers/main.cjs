const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

function loadMain({ overrides = {}, userData, onSend = () => {}, shell = {}, development = false, rendererSettings = 'manual' } = {}) {
  const filename = path.resolve(__dirname, '../../electron/main.cjs');
  const requireMain = createRequire(filename);
  const handlers = new Map();
  const appURL = development ? 'http://localhost:5173/' : pathToFileURL(path.resolve(__dirname, '../../dist/index.html')).href;
  let nextSenderId = 1;
  function makeSender() {
    return Object.assign(new EventEmitter(), {
      id: nextSenderId++, mainFrame: { url: appURL }, destroyed: false,
      isDestroyed() { return this.destroyed; },
      send(channel, data) {
        onSend(channel, data, BrowserWindow.fromWebContents(this));
        if (rendererSettings === 'auto' && channel === 'settings:flush') {
          queueMicrotask(() => handlers.get('settings:flushResult')(eventFor(this), data.requestId, { ok: true }));
        }
      },
      setWindowOpenHandler(handler) { this.windowOpenHandler = handler; },
    });
  }
  function eventFor(target) {
    const sender = target.webContents || target;
    return { sender, senderFrame: sender.mainFrame };
  }
  const sender = makeSender();
  const frame = sender.mainFrame;
  const event = { sender, senderFrame: frame };
  const protocols = new Map();
  const windows = [];
  const dialogs = [];
  let ready;
  let schemes;
  let firstWindow = true;
  let closingForQuit = false;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = firstWindow ? sender : makeSender();
      firstWindow = false;
      this.destroyed = false;
      this.enabled = true;
      this.closeAttempts = 0;
      windows.push(this);
    }
    loadURL(url) {
      this.url = url;
      this.webContents.mainFrame.url = url;
      this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      if (rendererSettings === 'auto') queueMicrotask(() => handlers.get('settings:ready')(eventFor(this), true));
    }
    loadFile(filename) { this.loadURL(pathToFileURL(filename).href); }
    isDestroyed() { return this.destroyed; }
    isEnabled() { return this.enabled; }
    setEnabled(enabled) { this.enabled = enabled; }
    close() {
      this.closeAttempts++;
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', event);
      if (!event.defaultPrevented) this.destroy();
      return event;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.destroyed = true;
      windows.splice(windows.indexOf(this), 1);
      this.emit('closed');
      this.webContents.emit('destroyed');
      if (!windows.length && !closingForQuit) app.emit('window-all-closed');
    }
    static fromWebContents(contents) { return windows.find((window) => window.webContents === contents) || null; }
    static getAllWindows() { return windows; }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: !development,
    whenReady: () => ({ then(callback) { ready = callback; } }),
    getPath: () => userData,
    quitAttempts: 0,
    completedQuits: 0,
    quit() {
      this.quitAttempts++;
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('before-quit', event);
      if (!event.defaultPrevented) {
        closingForQuit = true;
        for (const win of [...windows]) win.close();
        closingForQuit = false;
        if (!windows.length) {
          this.completedQuits++;
          this.emit('will-quit');
        }
      }
      return event;
    },
  });
  const electron = {
    app,
    protocol: { registerSchemesAsPrivileged(value) { schemes = value; }, handle: (name, callback) => protocols.set(name, callback) },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    BrowserWindow,
    net: { fetch: async () => new Response('preview') },
    shell: { trashItem: async () => {}, ...shell },
    clipboard: { writeText() {} },
    dialog: { showMessageBox: async (...args) => { dialogs.push(args); return { response: 0 }; } },
  };
  const evaluate = vm.runInThisContext(`(function(require, __dirname, process) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  Object.assign(electron, overrides.electron);
  evaluate((name) => name === 'electron' ? electron : overrides[name] || requireMain(name), path.dirname(filename),
    { ...process, env: { ...process.env, VITE_DEV: development ? '1' : undefined } });
  return { handlers, event, electron, protocols, windows, dialogs, schemes, ready: () => ready(), eventFor,
    invokeFrom: (target, name, ...args) => handlers.get(name)(eventFor(target), ...args),
    invoke: (name, ...args) => handlers.get(name)(event, ...args) };
}

module.exports = { loadMain };
