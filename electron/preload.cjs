const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  readDir: (p) => ipcRenderer.invoke('fs:readDir', p),
  specialDirs: () => ipcRenderer.invoke('fs:specialDirs'),
  copy: (paths, destDir) => ipcRenderer.invoke('fs:copy', paths, destDir),
  move: (paths, destDir) => ipcRenderer.invoke('fs:move', paths, destDir),
  trash: (paths) => ipcRenderer.invoke('fs:trash', paths),
  rename: (p, newName) => ipcRenderer.invoke('fs:rename', p, newName),
  mkdir: (parent, name) => ipcRenderer.invoke('fs:mkdir', parent, name),
  newFile: (parent, name) => ipcRenderer.invoke('fs:newFile', parent, name),
  open: (p) => ipcRenderer.invoke('fs:open', p),
  reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
  readText: (p, maxBytes) => ipcRenderer.invoke('fs:readText', p, maxBytes),
  statfs: (p) => ipcRenderer.invoke('fs:statfs', p),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  search: (root, query, opts) => ipcRenderer.invoke('fs:search', root, query, opts),
  copyTextToClipboard: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  pathForFile: (file) => webUtils.getPathForFile(file),
  watchDir: (paneId, dirPath) => ipcRenderer.invoke('fs:watch', paneId, dirPath),
  unwatchDir: (paneId) => ipcRenderer.invoke('fs:unwatch', paneId),
  onDirChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('fs:dirChanged', listener);
    return () => ipcRenderer.removeListener('fs:dirChanged', listener);
  },
});
