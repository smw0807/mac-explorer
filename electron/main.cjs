const { app, BrowserWindow, ipcMain, shell, clipboard, protocol, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { pathToFileURL } = require('url');

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

async function uniqueDest(destDir, name) {
  let candidate = path.join(destDir, name);
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, `${base} copy${i > 1 ? ' ' + i : ''}${ext}`);
    i++;
  }
  return candidate;
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
  const names = paths
    .filter((p) => path.dirname(p) !== destDir)
    .map((p) => path.basename(p))
    .filter((name) => fs.existsSync(path.join(destDir, name)));
  return ok({ names });
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

// 충돌 정책 적용: 최종 dest 경로를 돌려주고, skip이면 null
async function resolveDest(p, destDir, conflict) {
  let dest = path.join(destDir, path.basename(p));
  if (path.dirname(p) === destDir) return uniqueDest(destDir, path.basename(p));
  if (fs.existsSync(dest)) {
    if (conflict === 'skip') return null;
    if (conflict === 'keepBoth') return uniqueDest(destDir, path.basename(p));
    if (conflict === 'overwrite') {
      await fsp.rm(dest, { recursive: true, force: true });
      return dest;
    }
    throw new Error(`이미 존재합니다: ${path.basename(p)}`);
  }
  return dest;
}

ipcMain.handle('fs:copy', async (_e, paths, destDir, opts = {}) => {
  try {
    const created = [];
    for (const p of paths) {
      const dest = await resolveDest(p, destDir, opts.conflict);
      if (!dest) continue;
      await fsp.cp(p, dest, { recursive: true, errorOnExist: true, force: false });
      created.push(dest);
    }
    return ok({ created });
  } catch (err) { return fail(err); }
});

/* ---------- copy with progress ---------- */

let copyJobSeq = 0;
const copyJobs = new Map(); // jobId → { canceled }

async function treeSize(p) {
  const st = await fsp.lstat(p);
  if (!st.isDirectory()) return st.size;
  let sum = 0;
  for (const n of await fsp.readdir(p)) sum += await treeSize(path.join(p, n));
  return sum;
}

function cancelError() {
  return Object.assign(new Error('취소됨'), { canceled: true });
}

function copyFileStream(job, src, dest, onBytes) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest, { flags: 'wx' });
    rs.on('data', (chunk) => {
      if (job.canceled) {
        rs.destroy();
        ws.destroy();
        reject(cancelError());
        return;
      }
      onBytes(chunk.length);
    });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('close', resolve);
    rs.pipe(ws);
  });
}

async function copyTree(job, src, dest, report) {
  if (job.canceled) throw cancelError();
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(src), dest);
  } else if (st.isDirectory()) {
    await fsp.mkdir(dest);
    for (const n of await fsp.readdir(src)) {
      await copyTree(job, path.join(src, n), path.join(dest, n), report);
    }
  } else {
    report.currentFile = src;
    await copyFileStream(job, src, dest, (n) => { report.copied += n; });
  }
}

ipcMain.handle('fs:copyStart', (e, paths, destDir, opts = {}) => {
  const jobId = ++copyJobSeq;
  const job = { canceled: false };
  copyJobs.set(jobId, job);
  const sender = e.sender;

  (async () => {
    const report = { copied: 0, total: 0, currentFile: '' };
    const send = (extra = {}) => {
      if (!sender.isDestroyed()) {
        sender.send('fs:copyProgress', {
          jobId, copied: report.copied, total: report.total, currentFile: report.currentFile, ...extra,
        });
      }
    };
    const timer = setInterval(() => send(), 100);
    let inFlightDest = null; // 복사가 끝나지 않은 항목만 취소/실패 시 정리
    const created = [];
    try {
      for (const p of paths) report.total += await treeSize(p);
      send();
      for (const p of paths) {
        if (job.canceled) throw cancelError();
        const dest = await resolveDest(p, destDir, opts.conflict);
        if (!dest) continue;
        inFlightDest = dest;
        await copyTree(job, p, dest, report);
        created.push(dest);
        inFlightDest = null;
      }
      clearInterval(timer);
      send({ done: true, created });
    } catch (err) {
      clearInterval(timer);
      if (inFlightDest) await fsp.rm(inFlightDest, { recursive: true, force: true }).catch(() => {});
      send({ done: true, canceled: !!err.canceled, error: err.canceled ? null : (err.message || String(err)) });
    } finally {
      copyJobs.delete(jobId);
    }
  })();

  return ok({ jobId });
});

ipcMain.handle('fs:copyCancel', (_e, jobId) => {
  const job = copyJobs.get(jobId);
  if (job) job.canceled = true;
  return ok({});
});

ipcMain.handle('fs:move', async (_e, paths, destDir, opts = {}) => {
  try {
    const items = [];
    for (const p of paths) {
      if (path.dirname(p) === destDir) continue;
      let dest = path.join(destDir, path.basename(p));
      if (fs.existsSync(dest)) {
        if (opts.conflict === 'skip') continue;
        else if (opts.conflict === 'keepBoth') dest = await uniqueDest(destDir, path.basename(p));
        else if (opts.conflict === 'overwrite') await fsp.rm(dest, { recursive: true, force: true });
        else throw new Error(`이미 존재합니다: ${path.basename(p)}`);
      }
      try {
        await fsp.rename(p, dest);
      } catch (err) {
        if (err.code === 'EXDEV') {
          await fsp.cp(p, dest, { recursive: true });
          await fsp.rm(p, { recursive: true });
        } else throw err;
      }
      items.push({ from: p, to: dest });
    }
    return ok({ items });
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:trash', async (_e, paths) => {
  try {
    for (const p of paths) await shell.trashItem(p);
    return ok({});
  } catch (err) { return fail(err); }
});

ipcMain.handle('fs:rename', async (_e, p, newName) => {
  try {
    const dest = path.join(path.dirname(p), newName);
    if (fs.existsSync(dest)) throw new Error(`이미 존재합니다: ${newName}`);
    await fsp.rename(p, dest);
    return ok({ path: dest });
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

ipcMain.handle('fs:reveal', async (_e, p) => {
  shell.showItemInFolder(p);
  return ok({});
});

ipcMain.handle('fs:readText', async (_e, p, maxBytes = 200 * 1024) => {
  try {
    const fh = await fsp.open(p, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    await fh.close();
    return ok({ text: buf.slice(0, bytesRead).toString('utf8') });
  } catch (err) { return fail(err); }
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

// Recursive search with limits
ipcMain.handle('fs:search', async (_e, rootPath, query, opts = {}) => {
  const maxResults = opts.maxResults || 500;
  const maxDepth = opts.maxDepth || 8;
  const q = query.toLowerCase();
  const results = [];
  const skip = new Set(['node_modules', 'Library', '.git', '.Trash']);

  async function walk(dir, depth) {
    if (results.length >= maxResults || depth > maxDepth) return;
    let names;
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const name of names) {
      if (results.length >= maxResults) return;
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (name.toLowerCase().includes(q)) {
        const info = await entryInfo(dir, name);
        if (info) results.push(info);
      }
      if (!skip.has(name)) {
        let st;
        try { st = await fsp.lstat(full); } catch { continue; }
        if (st.isDirectory()) await walk(full, depth + 1);
      }
    }
  }

  try {
    await walk(rootPath, 0);
    return ok({ entries: results });
  } catch (err) { return fail(err); }
});
