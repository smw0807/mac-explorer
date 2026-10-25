const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

function loadMain({ overrides = {}, userData, onSend = () => {}, shell = {}, development = false } = {}) {
  const filename = path.resolve(__dirname, '../../electron/main.cjs');
  const requireMain = createRequire(filename);
  const handlers = new Map();
  const frame = { url: development ? 'http://localhost:5173/' : pathToFileURL(path.resolve(__dirname, '../../dist/index.html')).href };
  const sender = Object.assign(new EventEmitter(), {
    id: 1, mainFrame: frame, isDestroyed: () => false, send: onSend,
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; },
  });
  const event = { sender, senderFrame: frame };
  const protocols = new Map();
  const windows = [];
  let ready;
  let schemes;
  class BrowserWindow {
    constructor(options) { this.options = options; this.webContents = sender; windows.push(this); }
    loadURL(url) { this.url = url; }
    loadFile(filename) { this.url = pathToFileURL(filename).href; }
    static fromWebContents(contents) { return windows.find((window) => window.webContents === contents) || null; }
    static getAllWindows() { return windows; }
  }
  const electron = {
    app: { isPackaged: !development, whenReady: () => ({ then(callback) { ready = callback; } }), on() {}, getPath: () => userData },
    protocol: { registerSchemesAsPrivileged(value) { schemes = value; }, handle: (name, callback) => protocols.set(name, callback) },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    BrowserWindow,
    net: { fetch: async () => new Response('preview') },
    shell: { trashItem: async () => {}, ...shell },
    clipboard: { writeText() {} },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
  };
  const evaluate = vm.runInThisContext(`(function(require, __dirname, process) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  Object.assign(electron, overrides.electron);
  evaluate((name) => name === 'electron' ? electron : overrides[name] || requireMain(name), path.dirname(filename),
    { ...process, env: { ...process.env, VITE_DEV: development ? '1' : undefined } });
  return { handlers, event, electron, protocols, windows, schemes, ready: () => ready(),
    invoke: (name, ...args) => handlers.get(name)(event, ...args) };
}

module.exports = { loadMain };
