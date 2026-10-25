const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

function loadMain({ overrides = {}, userData, onSend = () => {}, shell = {} } = {}) {
  const filename = path.resolve(__dirname, '../../electron/main.cjs');
  const requireMain = createRequire(filename);
  const handlers = new Map();
  const frame = { url: pathToFileURL(path.resolve(__dirname, '../../dist/index.html')).href };
  const sender = { id: 1, mainFrame: frame, isDestroyed: () => false, once() {}, removeListener() {}, send: onSend };
  const event = { sender, senderFrame: frame };
  const electron = {
    app: { isPackaged: true, whenReady: () => ({ then() {} }), on() {}, getPath: () => userData },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    BrowserWindow: { fromWebContents: () => null },
    shell: { trashItem: async () => {}, ...shell },
    clipboard: { writeText() {} },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
  };
  const evaluate = vm.runInThisContext(`(function(require, __dirname) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  evaluate((name) => name === 'electron' ? electron : overrides[name] || requireMain(name), path.dirname(filename));
  return { handlers, event, invoke: (name, ...args) => handlers.get(name)(event, ...args) };
}

module.exports = { loadMain };
