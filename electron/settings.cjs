const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { absolutePath, isPlainObject, validateSettingsPatch } = require('./ipc-validation.cjs');

function validPath(value) {
  try { absolutePath(value); return true; } catch { return false; }
}

function sanitizeSettings(value) {
  if (!isPlainObject(value)) return {};
  const result = {};
  if (Array.isArray(value.favorites)) {
    result.favorites = value.favorites.slice(0, 2000).filter((entry) => isPlainObject(entry)
      && validPath(entry.path) && typeof entry.name === 'string' && entry.name.length > 0
      && entry.name.length <= 4096 && !entry.name.includes('\0'))
      .map(({ path: p, name, icon }) => ({ path: p, name,
        icon: typeof icon === 'string' && icon.length > 0 && icon.length <= 128 && !icon.includes('\0') ? icon : '📁' }));
  }
  if (isPlainObject(value.session)) {
    const saved = value.session;
    const tabs = (Array.isArray(saved.tabs) ? saved.tabs : []).slice(0, 2000)
      .filter(isPlainObject).map((entry) => {
        const paths = (Array.isArray(entry.paths) ? entry.paths : []).filter(validPath).slice(0, 2);
        return { paths, dual: entry.dual === true && paths.length === 2 };
      }).filter((entry) => entry.paths.length > 0);
    result.session = {
      tabs,
      active: Number.isSafeInteger(saved.active) ? Math.max(0, Math.min(saved.active, tabs.length - 1)) : 0,
      showHidden: saved.showHidden === true,
    };
  }
  return result;
}

function readSettings(filename, io = fs) {
  try {
    if (io.statSync(filename).size > 1024 * 1024) return {};
    return sanitizeSettings(JSON.parse(io.readFileSync(filename, 'utf8')));
  } catch { return {}; }
}

function writeSettings(filename, patch, io = fs) {
  validateSettingsPatch(patch);
  const data = JSON.stringify(sanitizeSettings({ ...readSettings(filename, io), ...patch }), null, 2);
  if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('설정 파일이 너무 큽니다.');
  const temporary = path.join(path.dirname(filename), `.settings-${randomUUID()}.tmp`);
  let fd;
  let created = false;
  try {
    fd = io.openSync(temporary, 'wx', 0o600);
    created = true;
    io.writeFileSync(fd, data, 'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd); } catch { /* preserve the write error */ } }
    if (created) { try { io.unlinkSync(temporary); } catch { /* renamed or already removed */ } }
  }
}

module.exports = { sanitizeSettings, readSettings, writeSettings };
