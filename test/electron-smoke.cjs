// Launched by scripts/test-electron.cjs with a unique, disposable profile and home.
const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const fixture = process.env.MAC_EXPLORER_SMOKE_ROOT;
if (!fixture) throw new Error('npm run test:electron으로 실행해주세요.');
const home = path.join(fixture, 'home');
const profile = path.join(fixture, 'profile');
fs.mkdirSync(home);
fs.mkdirSync(profile);
const testTrash = path.join(fixture, 'test-trash');
fs.mkdirSync(testTrash);
// A failed guard must never send even a fixture to the user's actual Trash.
shell.trashItem = async (file) => {
  assert.ok(file.startsWith(home + path.sep), 'trash escaped the fixture');
  fs.renameSync(file, path.join(testTrash, path.basename(file)));
};
fs.mkdirSync(path.join(home, 'destination'));
fs.mkdirSync(path.join(home, 'source-real'));
fs.symlinkSync('source-real', path.join(home, 'source-alias'));
fs.writeFileSync(path.join(home, 'source-real', 'move.txt'), 'alias move contents');
fs.writeFileSync(path.join(home, 'sample.txt'), 'native smoke contents');
fs.writeFileSync(path.join(home, 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');

// Silent PCM audio exercises the media protocol without playing any sound.
const audio = Buffer.alloc(16044);
audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
audio.write('data', 36); audio.writeUInt32LE(16000, 40);
fs.writeFileSync(path.join(home, 'silent.wav'), audio);

app.setPath('userData', profile);
os.homedir = () => home;
const timeout = setTimeout(() => { console.error('실제 앱 검증 시간 초과'); app.exit(1); }, 20000);
app.on('will-quit', () => clearTimeout(timeout));

app.on('browser-window-created', (_event, win) => {
  win.hide();
  win.webContents.once('render-process-gone', (_event, details) => {
    console.error('Renderer terminated:', details.reason);
    app.exit(1);
  });
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const home = ${JSON.stringify(home)};
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        for (let i = 0; i < 500 && !document.querySelector('.pane'); i++) await new Promise(r => setTimeout(r, 10));
        check(window.api && document.querySelector('.pane'), 'preload/React initialization failed');
        check(typeof require === 'undefined' && typeof process === 'undefined', 'Node globals exposed to renderer');
        const listing = await window.api.readDir(home);
        check(listing.ok && listing.entries.some(e => e.name === 'sample.txt'), 'directory read failed');
        const copied = await window.api.copy([home + '/sample.txt'], home + '/destination');
        check(copied.ok && copied.created.length === 1, 'copy failed: ' + copied.error);
        const text = await window.api.readText(copied.created[0]);
        check(text.ok && text.text === 'native smoke contents', 'text preview failed');
        check(copied.undo?.length === 1, 'copy undo receipt missing');
        const moved = await window.api.move([home + '/source-alias/move.txt'], home + '/destination');
        check(moved.ok && moved.undo?.length === 1, 'alias move receipt missing');
        const restored = await window.api.undo(moved.undo[0].token);
        check(restored.ok && (await window.api.exists(home + '/source-alias/move.txt')).exists, 'alias undo failed');
        check(!(await window.api.undo(moved.undo[0].token)).ok, 'consumed undo receipt replayed');
        await new Promise((resolve, reject) => {
          const img = new Image(); img.onload = resolve; img.onerror = () => reject(new Error('image preview failed'));
          img.src = 'localfile://' + encodeURIComponent(home + '/pixel.svg');
        });
        await new Promise((resolve, reject) => {
          const media = document.createElement('audio');
          media.onloadedmetadata = () => { media.removeAttribute('src'); media.load(); resolve(); };
          media.onerror = () => reject(new Error('audio metadata failed'));
          media.src = 'localfile://' + encodeURIComponent(home + '/silent.wav');
          media.preload = 'metadata'; media.load();
        });
        check(!(await window.api.rename(copied.created[0], '../escaped.txt')).ok, 'invalid filename accepted');
        check((await window.api.settingsSet({favorites: []})).ok, 'settings write failed');
        const saved = await window.api.settingsGet();
        check(Array.isArray(saved.settings.favorites) && saved.settings.favorites.length === 0, 'settings round trip failed');
        const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content;
        check(csp?.includes("script-src 'self';") && csp.includes("connect-src 'none'"), 'production CSP missing');
        window.open('https://example.com');
        return { rendered: true, ipc: true, copy: true, text: true, image: true, audio: true, settings: true, csp: true,
          aliasUndo: true, copiedPath: copied.created[0], copiedToken: copied.undo[0].token };
      })()`);
      fs.renameSync(result.copiedPath, path.join(home, 'original-copy.txt'));
      fs.writeFileSync(result.copiedPath, 'unrelated replacement');
      const rejected = await win.webContents.executeJavaScript(`window.api.undo(${JSON.stringify(result.copiedToken)})`);
      assert.equal(rejected.ok, false, 'undo accepted an unrelated replacement');
      assert.equal(fs.readFileSync(result.copiedPath, 'utf8'), 'unrelated replacement');
      delete result.copiedPath;
      delete result.copiedToken;
      result.undoReplacementProtected = true;
      assert.equal(BrowserWindow.getAllWindows().length, 1, 'popup was not blocked');
      assert.equal(fs.readFileSync(path.join(home, 'sample.txt'), 'utf8'), 'native smoke contents');
      assert.equal(fs.existsSync(path.join(home, 'escaped.txt')), false);
      console.log('Electron smoke passed:', JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});

require('../electron/main.cjs');
