// Native keyboard defaults are not implemented by jsdom; verify them in Chromium.
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const root = process.env.MAC_EXPLORER_SMOKE_ROOT;
if (!root) throw new Error('npm run test:electron으로 실행해주세요.');
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
fs.mkdirSync(profile);
for (const name of ['first.txt', 'second.txt']) fs.writeFileSync(path.join(home, name), name);
app.setPath('userData', profile);
os.homedir = () => home;
let renames = 0;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (...args) => {
  if (channel === 'fs:rename') renames++;
  return callback(...args);
});
const timer = setTimeout(() => { console.error('키보드 UI 검증 시간 초과'); app.exit(1); }, 15000);
app.on('will-quit', () => clearTimeout(timer));
app.on('browser-window-created', (_event, win) => {
  win.hide();
  win.webContents.once('did-finish-load', async () => {
    try {
      await win.webContents.executeJavaScript(`(async () => {
        const tick = () => new Promise(resolve => setTimeout(resolve, 10));
        for (let i = 0; i < 500 && document.querySelectorAll('.fl-row').length !== 2; i++) await tick();
        const rows = document.querySelectorAll('.fl-row');
        if (rows.length !== 2) throw new Error('fixture rows missing');
        rows[0].dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await tick();
        rows[1].dispatchEvent(new MouseEvent('click', {bubbles: true, metaKey: true}));
        await tick();
        rows[1].dispatchEvent(new MouseEvent('contextmenu', {bubbles: true}));
        await tick();
        [...document.querySelectorAll('.cm-item')].find(button => button.textContent.includes('일괄 이름 변경')).click();
        await tick();
        [...document.querySelectorAll('.modal-modes button')].find(button => button.textContent === '연번 이름').click();
        await tick();
        const apply = document.querySelector('.modal-actions .primary');
        if (!apply || apply.disabled) throw new Error('rename proposal missing');
        const cancel = [...document.querySelectorAll('.modal-actions button')].find(button => button.textContent === '취소');
        cancel.focus();
        if (document.activeElement !== cancel) throw new Error('Cancel was not focused');
      })()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await win.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 100 && document.querySelector('.modal'); i++) await new Promise(resolve => setTimeout(resolve, 10));
        if (document.querySelector('.modal')) throw new Error('Enter did not activate Cancel');
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(renames, 0, 'Enter on Cancel submitted a rename');
      assert.deepEqual(fs.readdirSync(home).sort(), ['first.txt', 'second.txt']);
      console.log('Electron keyboard passed: Cancel Enter closes the dialog without renaming');
      app.quit();
    } catch (error) { console.error(error); clearTimeout(timer); app.exit(1); }
  });
});
require('../electron/main.cjs');
