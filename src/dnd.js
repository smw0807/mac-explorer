import { parentPath } from './util.js';

export const DND_TYPE = 'application/x-mac-explorer-paths';

// 파일 작업 후 해당 디렉터리를 보고 있는 패널들에 새로 고침을 알린다
export function notifyFsChanged(dirs) {
  window.dispatchEvent(new CustomEvent('mx-fs-changed', { detail: { dirs } }));
}

export function acceptsDrop(e) {
  const t = e.dataTransfer.types;
  return t.includes(DND_TYPE) || t.includes('Files');
}

export function startDrag(e, paths) {
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(paths));
  e.dataTransfer.effectAllowed = 'copyMove';
}

export function extractDropPaths(e) {
  const raw = e.dataTransfer.getData(DND_TYPE);
  if (raw) {
    try { return JSON.parse(raw); } catch { return []; }
  }
  // Finder 등 외부에서 드롭된 파일
  return [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
}

// destDir로 드롭 처리. 기본은 이동, Alt(Option) 누르면 복사.
export async function dropToDir(e, destDir) {
  const paths = extractDropPaths(e);
  if (!paths.length) return;
  // 자기 자신이나 하위 폴더로의 드롭은 무시
  if (paths.some((p) => destDir === p || destDir.startsWith(p + '/'))) return;
  const copyMode = e.altKey;
  if (!copyMode && paths.every((p) => parentPath(p) === destDir)) return;
  const res = copyMode
    ? await window.api.copy(paths, destDir)
    : await window.api.move(paths, destDir);
  if (!res.ok) alert(res.error);
  notifyFsChanged([...new Set([destDir, ...paths.map(parentPath)])]);
}
