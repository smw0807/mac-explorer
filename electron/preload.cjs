const { contextBridge, ipcRenderer, webUtils } = require('electron');

let settingsSubscription;
function settingsFailure(value) {
  const message = typeof value === 'string' ? value : value?.message;
  return { ok: false, error: (typeof message === 'string' ? message.replace(/\0/g, '').slice(0, 4096) : '')
    || '설정을 저장하지 못했습니다.' };
}

function onSettingsFlush(callback) {
  if (typeof callback !== 'function') throw new TypeError('설정 저장 함수를 전달해야 합니다.');
  settingsSubscription?.unsubscribe();
  const subscription = { seen: new Set() };
  const listener = (_event, request) => {
    if (!request || typeof request.requestId !== 'string' || !['close', 'quit'].includes(request.reason)
      || subscription.seen.has(request.requestId)) return;
    subscription.seen.add(request.requestId);
    if (subscription.seen.size > 128) subscription.seen.delete(subscription.seen.values().next().value);
    void (async () => {
      let result;
      try {
        const saved = await callback({ reason: request.reason });
        result = saved?.ok === true ? { ok: true } : settingsFailure(saved?.error);
      } catch (error) { result = settingsFailure(error); }
      if (settingsSubscription !== subscription) return;
      try { await ipcRenderer.invoke('settings:flushResult', request.requestId, result); }
      catch { /* Main's deadline handles a renderer whose acknowledgment cannot arrive. */ }
    })();
  };
  subscription.unsubscribe = () => {
    if (settingsSubscription !== subscription) return;
    settingsSubscription = undefined;
    ipcRenderer.removeListener('settings:flush', listener);
    try { void ipcRenderer.invoke('settings:ready', false).catch(() => {}); }
    catch { /* The renderer may already be closing. */ }
  };
  settingsSubscription = subscription;
  ipcRenderer.on('settings:flush', listener);
  return subscription.unsubscribe;
}

contextBridge.exposeInMainWorld('api', {
  readDir: (p) => ipcRenderer.invoke('fs:readDir', p),
  specialDirs: () => ipcRenderer.invoke('fs:specialDirs'),
  copy: (paths, destDir, opts) => ipcRenderer.invoke('fs:copy', paths, destDir, opts),
  move: (paths, destDir, opts) => ipcRenderer.invoke('fs:move', paths, destDir, opts),
  conflicts: (paths, destDir) => ipcRenderer.invoke('fs:conflicts', paths, destDir),
  confirmConflict: (names) => ipcRenderer.invoke('ui:confirmConflict', names),
  trash: (paths) => ipcRenderer.invoke('fs:trash', paths),
  rename: (p, newName) => ipcRenderer.invoke('fs:rename', p, newName),
  undo: (token) => ipcRenderer.invoke('fs:undo', token),
  undoRelease: (tokens) => ipcRenderer.invoke('fs:undoRelease', tokens),
  mkdir: (parent, name) => ipcRenderer.invoke('fs:mkdir', parent, name),
  newFile: (parent, name) => ipcRenderer.invoke('fs:newFile', parent, name),
  open: (p) => ipcRenderer.invoke('fs:open', p),
  reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
  quickLook: (p) => ipcRenderer.invoke('fs:quickLook', p),
  pickApp: () => ipcRenderer.invoke('ui:pickApp'),
  openWithApp: (filePath, appPath) => ipcRenderer.invoke('fs:openWithApp', filePath, appPath),
  readText: (p, maxBytes) => ipcRenderer.invoke('fs:readText', p, maxBytes),
  statfs: (p) => ipcRenderer.invoke('fs:statfs', p),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  search: (root, query, opts) => ipcRenderer.invoke('fs:search', root, query, opts),
  searchSpotlight: (root, query, opts) => ipcRenderer.invoke('fs:searchSpotlight', root, query, opts),
  copyTextToClipboard: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  pathForFile: (file) => webUtils.getPathForFile(file),
  fileIcon: (p) => ipcRenderer.invoke('fs:fileIcon', p),
  compress: (paths) => ipcRenderer.invoke('fs:compress', paths),
  extract: (zipPath) => ipcRenderer.invoke('fs:extract', zipPath),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  settingsReady: async () => settingsSubscription ? ipcRenderer.invoke('settings:ready', true)
    : settingsFailure('설정 저장 처리가 아직 준비되지 않았습니다.'),
  onSettingsFlush,
  copyStart: (paths, destDir, opts) => ipcRenderer.invoke('fs:copyStart', paths, destDir, opts),
  copyCancel: (jobId) => ipcRenderer.invoke('fs:copyCancel', jobId),
  onCopyProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('fs:copyProgress', listener);
    return () => ipcRenderer.removeListener('fs:copyProgress', listener);
  },
  watchDir: (paneId, dirPath) => ipcRenderer.invoke('fs:watch', paneId, dirPath),
  unwatchDir: (paneId) => ipcRenderer.invoke('fs:unwatch', paneId),
  onDirChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('fs:dirChanged', listener);
    return () => ipcRenderer.removeListener('fs:dirChanged', listener);
  },
});
