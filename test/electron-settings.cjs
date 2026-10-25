const { app, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const root = process.env.MAC_EXPLORER_SMOKE_ROOT;
const mode = process.env.MAC_EXPLORER_LIFECYCLE_MODE;
if (!root || !['settings-close', 'settings-quit', 'settings-retry'].includes(mode)) {
  throw new Error('npm run test:electron으로 실행해주세요.');
}
const home = path.join(root, 'home');
const folder = path.join(home, 'folder');
const profile = path.join(root, 'profile');
fs.mkdirSync(folder, { recursive: true });
fs.mkdirSync(profile);
const settingsFile = path.join(profile, 'settings.json');
const favorite = { icon: '📁', name: '보관', path: folder };
const initial = {
  favorites: [{ icon: '🏠', name: '홈', path: home }, favorite],
  session: { tabs: [{ dual: false, paths: [home] }], active: 0, showHidden: false },
};
fs.writeFileSync(settingsFile, JSON.stringify(initial));
app.setPath('userData', profile);
os.homedir = () => home;

let ready;
const rendererReady = new Promise((resolve) => { ready = resolve; });
let failedSave = false;
let rejectSave = false;
let notice;
const noticeShown = new Promise((resolve) => { notice = resolve; });
dialog.showMessageBox = async () => { notice(); return { response: 0 }; };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, async (...args) => {
  if (channel === 'settings:set' && rejectSave) {
    failedSave = true;
    return { ok: false, error: 'fixture: settings write denied' };
  }
  const result = await callback(...args);
  if (channel === 'settings:ready' && result?.ok) ready();
  return result;
});

let requested = false;
let failed = false;
const timer = setTimeout(() => fail(new Error('최종 설정 저장 검증 시간 초과')), 15000);
function fail(error) {
  if (failed) return;
  failed = true;
  console.error(error);
  clearTimeout(timer);
  app.exit(1);
}
function verify() {
  assert.equal(requested, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
    favorites: [favorite],
    session: {
      tabs: [{ dual: false, paths: [home] }, { dual: true, paths: [folder, folder] }],
      active: 1, showHidden: true,
    },
  });
  if (mode === 'settings-retry') assert.equal(failedSave, true);
  clearTimeout(timer);
  console.log(`Electron ${mode} passed: latest session and favorites saved before closing`);
}
app.on('will-quit', (event) => {
  if (mode !== 'settings-quit') return;
  try { verify(); }
  catch (error) { event.preventDefault(); fail(error); }
});
app.on('browser-window-created', (_event, win) => {
  win.hide();
  win.once('closed', () => {
    if (failed || mode === 'settings-quit') return;
    try { verify(); app.exit(0); } catch (error) { fail(error); }
  });
  win.webContents.once('did-finish-load', async () => {
    try {
      await rendererReady;
      const started = Date.now();
      await win.webContents.executeJavaScript(`(async () => {
        const tick = () => new Promise(resolve => setTimeout(resolve, 0));
        document.querySelector('.tab-add').click();
        await tick();
        document.querySelector('.titlebar-actions button[title^="숨김"]').click();
        const homeFavorite = [...document.querySelectorAll('.sb-item')].find(item => item.textContent.includes('홈'));
        homeFavorite.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        await tick();
        [...document.querySelectorAll('.cm-item')].find(item => item.textContent.includes('즐겨찾기에서 제거')).click();
        for (let i = 0; i < 100 && !document.querySelector('.panes:not([hidden]) .fl-row'); i++) await tick();
        const folder = [...document.querySelectorAll('.panes:not([hidden]) .fl-row')].find(row => row.querySelector('.fl-name')?.textContent === 'folder');
        if (!folder) throw new Error('fixture folder missing');
        folder.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        for (let i = 0; i < 100 && document.querySelector('.tab.active .tab-title')?.textContent !== 'folder'; i++) await tick();
        if (document.querySelector('.tab.active .tab-title')?.textContent !== 'folder') throw new Error('folder navigation not committed');
        document.querySelector('.titlebar-actions button[title^="듀얼"]').click();
        for (let i = 0; i < 100 && document.querySelectorAll('.panes:not([hidden]) .pane').length !== 2; i++) await tick();
        if (document.querySelectorAll('.panes:not([hidden]) .pane').length !== 2) throw new Error('dual pane not committed');
      })()`);
      assert.ok(Date.now() - started < 500, 'close must occur before the settings debounce');
      requested = true;
      if (mode === 'settings-quit') { app.quit(); return; }
      if (mode === 'settings-retry') rejectSave = true;
      win.close();
      if (mode === 'settings-retry') {
        await noticeShown;
        assert.equal(win.isDestroyed(), false, 'failed save must keep the window open');
        assert.equal(win.isEnabled(), true, 'failed close must restore input');
        assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), initial);
        rejectSave = false;
        win.close();
      }
    } catch (error) { fail(error); }
  });
});
require('../electron/main.cjs');
