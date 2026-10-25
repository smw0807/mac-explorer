const { app, BrowserWindow, ipcMain, shell, clipboard, protocol, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { statEntry, uniqueDest, copyItem, moveItem, treeSize, cancelError, validateBatch } = require('./file-operations.cjs');
const { compress } = require('./archive.cjs');

// custom protocol for previewing local files (images/video) in the renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'localfile', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true } },
]);

// `electron .` runs unpackaged even for production builds (npm start),
// so dev mode requires the dev script to opt in via VITE_DEV=1
const isDev = !app.isPackaged && process.env.VITE_DEV === '1';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#1e1e21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  protocol.handle('localfile', (request) => {
    const p = decodeURIComponent(request.url.slice('localfile://'.length));
    return net.fetch(pathToFileURL(p).toString());
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------- helpers ---------- */

async function entryInfo(dirPath, name) {
  const full = path.join(dirPath, name);
  let st;
  try {
    st = await fsp.lstat(full);
  } catch {
    return null;
  }
  let isDir = st.isDirectory();
  const isSymlink = st.isSymbolicLink();
  if (isSymlink) {
    try {
      const rst = await fsp.stat(full);
      isDir = rst.isDirectory();
    } catch { /* broken symlink */ }
  }
  return {
    name,
    path: full,
    isDir,
    isSymlink,
    size: isDir ? 0 : st.size,
    mtime: st.mtimeMs,
    ext: isDir ? '' : path.extname(name).slice(1).toLowerCase(),
    hidden: name.startsWith('.'),
  };
}

function ok(data) { return { ok: true, ...data }; }
function fail(err) { return { ok: false, error: err.message || String(err) }; }

/* ---------- IPC ---------- */

ipcMain.handle('fs:readDir', async (_e, dirPath) => {
  try {
    const names = await fsp.readdir(dirPath);
    const entries = (await Promise.all(names.map((n) => entryInfo(dirPath, n)))).filter(Boolean);
    return ok({ entries });
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:specialDirs', async () => {
  const home = os.homedir();
  let volumes = [];
  try {
    volumes = (await fsp.readdir('/Volumes')).map((v) => ({ name: v, path: path.join('/Volumes', v) }));
  } catch { /* ignore */ }
  return ok({
    home,
    desktop: path.join(home, 'Desktop'),
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
    pictures: path.join(home, 'Pictures'),
    applications: '/Applications',
    root: '/',
    volumes,
  });
});

// destDir에서 같은 이름이 이미 있는 항목 목록 (같은 폴더 내 복사는 자동으로 이름이 바뀌므로 제외)
ipcMain.handle('fs:conflicts', async (_e, paths, destDir) => {
  try {
    const names = [];
    for (const p of paths) {
      if (path.resolve(path.dirname(p)) !== path.resolve(destDir)
        && await statEntry(path.join(destDir, path.basename(p)))) names.push(path.basename(p));
    }
    return ok({ names });
  } catch (err) { return fail(err); }
});

ipcMain.handle('ui:confirmConflict', async (e, names) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['둘 다 유지', '덮어쓰기', '건너뛰기', '취소'],
    defaultId: 0,
    cancelId: 3,
    message: `대상 폴더에 같은 이름의 항목이 ${names.length}개 있습니다.`,
    detail: names.slice(0, 8).join('\n') + (names.length > 8 ? `\n… 외 ${names.length - 8}개` : ''),
  });
  return ok({ choice: ['keepBoth', 'overwrite', 'skip', 'cancel'][r.response] });
});

ipcMain.handle('fs:copy', async (_e, paths, destDir, opts = {}) => {
  const created = [];
  try {
    await validateBatch(paths, destDir, opts);
    for (const p of paths) {
      const dest = await copyItem(p, destDir, { ...opts, protectedDestinations: [...paths, ...created] });
      if (dest) created.push(dest);
    }
    return ok({ created });
  } catch (err) { return { ...fail(err), created }; }
});

/* ---------- copy with progress ---------- */

let copyJobSeq = 0;
const copyJobs = new Map(); // jobId → { canceled }

ipcMain.handle('fs:copyStart', (e, paths, destDir, opts = {}) => {
  const jobId = ++copyJobSeq;
  const job = { canceled: false, controller: new AbortController() };
  copyJobs.set(jobId, job);
  const sender = e.sender;
  const onDestroyed = () => { job.canceled = true; job.controller.abort(); };
  sender.once('destroyed', onDestroyed);

  (async () => {
    const report = { copied: 0, total: 0, currentFile: '' };
    const send = (extra = {}) => {
      if (!sender.isDestroyed()) {
        sender.send('fs:copyProgress', {
          jobId, destDir, copied: report.copied, total: report.total, currentFile: report.currentFile, ...extra,
        });
      }
    };
    const timer = setInterval(() => send(), 100);
    const created = [];
    try {
      await validateBatch(paths, destDir, opts);
      for (const p of paths) report.total += await treeSize(p, job);
      send();
      for (const p of paths) {
        if (job.canceled) throw cancelError();
        const dest = await copyItem(p, destDir, { ...opts, job, report, protectedDestinations: [...paths, ...created] });
        if (dest) created.push(dest);
      }
      clearInterval(timer);
      send({ done: true, created });
    } catch (err) {
      clearInterval(timer);
      send({ done: true, created, canceled: !!err.canceled, error: err.canceled ? null : (err.message || String(err)) });
    } finally {
      copyJobs.delete(jobId);
      sender.removeListener('destroyed', onDestroyed);
    }
  })();

  return ok({ jobId });
});

ipcMain.handle('fs:copyCancel', (_e, jobId) => {
  const job = copyJobs.get(jobId);
  if (job) { job.canceled = true; job.controller.abort(); }
  return ok({});
});

ipcMain.handle('fs:move', async (_e, paths, destDir, opts = {}) => {
  const items = [];
  const recovery = [];
  try {
    await validateBatch(paths, destDir, opts);
    for (const p of paths) {
      try {
        const dest = await moveItem(p, destDir, { ...opts, protectedDestinations: [...paths, ...items.map((item) => item.to)] });
        if (dest) items.push({ from: p, to: dest });
      } catch (err) {
        if (err.committedDest) recovery.push({ from: p, to: err.committedDest });
        throw err;
      }
    }
    return ok({ items });
  } catch (err) { return { ...fail(err), items, recovery }; }
});

ipcMain.handle('fs:trash', async (_e, paths) => {
  const trashed = [];
  try {
    for (const p of paths) {
      await shell.trashItem(p);
      trashed.push(p);
    }
    return ok({ trashed });
  } catch (err) { return { ...fail(err), trashed }; }
});

ipcMain.handle('fs:rename', async (_e, p, newName) => {
  try {
    const dest = await moveItem(p, path.dirname(p), { name: newName });
    return ok({ path: dest || p });
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:mkdir', async (_e, parent, name) => {
  try {
    const dest = await uniqueDest(parent, name || '새 폴더');
    await fsp.mkdir(dest);
    return ok({ path: dest });
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:newFile', async (_e, parent, name) => {
  try {
    const dest = await uniqueDest(parent, name || '새 파일.txt');
    await fsp.writeFile(dest, '', { flag: 'wx' });
    return ok({ path: dest });
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:fileIcon', async (_e, p) => {
  try {
    const img = await app.getFileIcon(p, { size: 'normal' });
    return ok({ dataUrl: img.toDataURL() });
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:open', async (_e, p) => {
  const err = await shell.openPath(p);
  return err ? fail(new Error(err)) : ok({});
});

// '다음으로 열기': 앱 선택 후 open -a로 실행
ipcMain.handle('ui:pickApp', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '연결할 앱 선택',
    defaultPath: '/Applications',
    properties: ['openFile'],
    filters: [{ name: '응용 프로그램', extensions: ['app'] }],
  });
  return ok({ path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] });
});

ipcMain.handle('fs:openWithApp', async (_e, filePath, appPath) => {
  try {
    await execFileP('open', ['-a', appPath, filePath]);
    return ok({});
  } catch (err) { return fail(err); }
});

// macOS Quick Look 미리보기 (qlmanage)
ipcMain.handle('fs:quickLook', (_e, p) => {
  try {
    const child = require('child_process').spawn('qlmanage', ['-p', p], { detached: true, stdio: 'ignore' });
    child.unref();
    return ok({});
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:reveal', async (_e, p) => {
  shell.showItemInFolder(p);
  return ok({});
});

ipcMain.handle('fs:readText', async (_e, p, maxBytes = 200 * 1024) => {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return ok({ text: buf.slice(0, bytesRead).toString('utf8') });
  } catch (err) { return fail(err); }
  finally { await fh?.close().catch(() => {}); }
});

ipcMain.handle('fs:statfs', async (_e, p) => {
  try {
    const s = await fsp.statfs(p);
    return ok({ free: s.bavail * s.bsize, total: s.blocks * s.bsize });
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:exists', async (_e, p) => {
  try {
    const st = await fsp.stat(p);
    return ok({ exists: true, isDir: st.isDirectory() });
  } catch {
    return ok({ exists: false, isDir: false });
  }
});

/* ---------- zip (compress / extract) ---------- */

// 선택 항목들을 같은 폴더에 zip으로 압축 (Finder처럼 단일 항목은 그 이름, 여러 개면 '보관')
ipcMain.handle('fs:compress', async (_e, paths) => {
  try {
    return ok({ path: await compress(paths) });
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:extract', async (_e, zipPath) => {
  try {
    const dest = await uniqueDest(path.dirname(zipPath), path.basename(zipPath).replace(/\.zip$/i, ''));
    await execFileP('/usr/bin/ditto', ['-x', '-k', zipPath, dest]);
    return ok({ path: dest });
  } catch (err) { return fail(err); }
});

/* ---------- settings (session/favorites persistence) ---------- */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

ipcMain.handle('settings:get', () => ok({ settings: readSettings() }));

ipcMain.handle('settings:set', (_e, patch) => {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, 2));
    return ok({});
  } catch (err) { return fail(err); }
});

/* ---------- directory watch (auto refresh) ---------- */

// webContents id → (paneId → FSWatcher)
const dirWatchers = new Map();

function closeWatcher(wcId, paneId) {
  const paneWatchers = dirWatchers.get(wcId);
  const w = paneWatchers?.get(paneId);
  if (w) {
    clearTimeout(w.debounceTimer);
    w.close();
    paneWatchers.delete(paneId);
  }
}

ipcMain.handle('fs:watch', (e, paneId, dirPath) => {
  const wcId = e.sender.id;
  if (!dirWatchers.has(wcId)) {
    dirWatchers.set(wcId, new Map());
    e.sender.once('destroyed', () => {
      for (const [id] of dirWatchers.get(wcId)) closeWatcher(wcId, id);
      dirWatchers.delete(wcId);
    });
  }
  closeWatcher(wcId, paneId);
  try {
    const watcher = fs.watch(dirPath, () => {
      // 연속 이벤트를 묶어서 한 번만 알림
      clearTimeout(watcher.debounceTimer);
      watcher.debounceTimer = setTimeout(() => {
        if (!e.sender.isDestroyed()) e.sender.send('fs:dirChanged', { paneId, dir: dirPath });
      }, 200);
    });
    dirWatchers.get(wcId).set(paneId, watcher);
    return ok({});
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:unwatch', (e, paneId) => {
  closeWatcher(e.sender.id, paneId);
  return ok({});
});

ipcMain.handle('clipboard:writeText', (_e, text) => {
  clipboard.writeText(text);
  return ok({});
});

// Spotlight(mdfind) 검색: 파일 이름 + 내용, 인덱스 기반이라 즉시 응답
ipcMain.handle('fs:searchSpotlight', async (_e, rootPath, query, opts = {}) => {
  try {
    const q = query.replace(/["\\]/g, '');
    const { stdout } = await execFileP('mdfind',
      ['-0', '-onlyin', rootPath, `(kMDItemFSName == "*${q}*"cd) || (kMDItemTextContent == "${q}"cd)`],
      { maxBuffer: 16 * 1024 * 1024 });
    const all = stdout.split('\0').filter(Boolean).filter((p) => opts.showHidden || !hiddenWithin(rootPath, p));
    const lines = all.slice(0, 500);
    const entries = (await Promise.all(
      lines.map(async (p) => {
        const info = await entryInfo(path.dirname(p), path.basename(p));
        return info && { ...info, hidden: hiddenWithin(rootPath, p) };
      })
    )).filter(Boolean);
    return ok({ entries, truncated: all.length > 500 });
  } catch (err) { return fail(err); }
});

// Recursive search with limits
function hiddenWithin(root, p) {
  return path.relative(root, p).split(path.sep).some((part) => part.startsWith('.') && part !== '..');
}

ipcMain.handle('fs:search', async (_e, rootPath, query, opts = {}) => {
  const maxResults = Math.max(1, Math.min(5000, opts.maxResults ?? 500));
  const maxDepth = Math.max(0, Math.min(64, opts.maxDepth ?? 8));
  const q = query.toLowerCase();
  const results = [];
  const skip = new Set(['node_modules', 'Library']);
  let truncated = false;

  async function walk(dir, depth) {
    if (results.length >= maxResults || depth > maxDepth) { truncated = true; return; }
    let names;
    try { names = await fsp.readdir(dir); } catch (err) {
      if (depth === 0) throw err;
      truncated = true;
      return;
    }
    for (const name of names) {
      if (results.length >= maxResults) { truncated = true; return; }
      if (!opts.showHidden && name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (name.toLowerCase().includes(q)) {
        const info = await entryInfo(dir, name);
        if (info) results.push({ ...info, hidden: hiddenWithin(rootPath, full) });
      }
      let st;
      try { st = await fsp.lstat(full); } catch { truncated = true; continue; }
      if (st.isDirectory()) {
        if (skip.has(name)) truncated = true;
        else await walk(full, depth + 1);
      }
    }
  }

  try {
    await walk(rootPath, 0);
    return ok({ entries: results, truncated });
  } catch (err) { return fail(err); }
});
