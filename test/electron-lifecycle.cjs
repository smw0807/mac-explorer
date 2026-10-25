const { app } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const root = process.env.MAC_EXPLORER_SMOKE_ROOT;
const mode = process.env.MAC_EXPLORER_LIFECYCLE_MODE;
if (!root || !['move', 'copy'].includes(mode)) throw new Error('npm run test:electron으로 실행해주세요.');
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
const directory = path.join(home, 'destination');
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(profile);
const source = path.join(home, 'document.txt');
const destination = path.join(directory, 'document.txt');
fs.writeFileSync(source, 'source contents');
if (mode === 'copy') fs.writeFileSync(destination, 'old destination');
app.setPath('userData', profile);
os.homedir = () => home;

let staged = false;
let backedUp = false;
let quitRequested = false;
const rename = fsp.rename;
const lstat = fsp.lstat;
async function requestQuitDuringIO() {
  quitRequested = true;
  setImmediate(() => app.quit());
  // Deterministically exercise normal quit while a filesystem response is pending.
  await new Promise((resolve) => setTimeout(resolve, 300));
}
fsp.rename = async (from, to) => {
  if (mode === 'copy' && backedUp && to === destination && !quitRequested) await requestQuitDuringIO();
  const result = await rename(from, to);
  if (from === source && path.basename(to) === 'new') staged = true;
  if (from === destination && path.basename(to) === 'previous') backedUp = true;
  return result;
};
fsp.lstat = async (p, ...args) => {
  if (mode === 'move' && staged && p === destination && !quitRequested) await requestQuitDuringIO();
  return lstat(p, ...args);
};

const timer = setTimeout(() => { console.error('종료 대기 검증 시간 초과'); app.exit(1); }, 15000);
app.on('will-quit', (event) => {
  try {
    assert.equal(quitRequested, true);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'source contents');
    assert.equal(fs.existsSync(source), mode === 'copy');
    assert.deepEqual(fs.readdirSync(directory), ['document.txt']);
    clearTimeout(timer);
    console.log(`Electron ${mode} shutdown passed: committed file and temporary cleanup preserved`);
  } catch (error) {
    event.preventDefault();
    console.error(error);
    app.exit(1);
  }
});
app.on('browser-window-created', (_event, win) => {
  win.hide();
  win.webContents.once('did-finish-load', async () => {
    const method = mode === 'move' ? 'move' : 'copyStart';
    try {
      await win.webContents.executeJavaScript(`window.api.${method}([${JSON.stringify(source)}], ${JSON.stringify(directory)}, {conflict: 'overwrite'})`);
    } catch (error) {
      // The main process drains the mutation, then quits. Chromium can dispose
      // this executeJavaScript request before delivering its already-completed
      // IPC result; the will-quit handler still verifies the filesystem outcome.
      if (quitRequested && /Render frame was disposed before the request completed/.test(error.message)) return;
      console.error(error);
      app.exit(1);
    }
  });
});
require('../electron/main.cjs');
