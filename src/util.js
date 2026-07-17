export function basename(p) {
  if (p === '/') return 'Macintosh HD';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function parentPath(p) {
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

export function formatSize(bytes) {
  if (bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatDate(ms) {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}. ${pad(d.getMonth() + 1)}. ${pad(d.getDate())}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg']);
const CODE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'kt', 'swift', 'sh', 'css', 'html', 'json', 'yml', 'yaml', 'toml', 'sql', 'vue']);
const TEXT_EXTS = new Set(['txt', 'md', 'log', 'csv', 'tsv', 'xml', 'ini', 'conf', 'env', 'gitignore']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg']);
const DOC_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'hwp']);

export function fileIcon(entry) {
  if (entry.isDir) return entry.ext === 'app' || entry.name.endsWith('.app') ? '📦' : '📁';
  const e = entry.ext;
  if (IMAGE_EXTS.has(e)) return '🖼️';
  if (VIDEO_EXTS.has(e)) return '🎬';
  if (AUDIO_EXTS.has(e)) return '🎵';
  if (e === 'pdf') return '📕';
  if (ARCHIVE_EXTS.has(e)) return '🗜️';
  if (CODE_EXTS.has(e)) return '⚙️';
  if (DOC_EXTS.has(e)) return '📘';
  if (TEXT_EXTS.has(e)) return '📝';
  return '📄';
}

export function fileKind(entry) {
  if (entry.isDir) return entry.name.endsWith('.app') ? '응용 프로그램' : '폴더';
  const e = entry.ext;
  if (!e) return '문서';
  if (IMAGE_EXTS.has(e)) return `${e.toUpperCase()} 이미지`;
  if (VIDEO_EXTS.has(e)) return `${e.toUpperCase()} 동영상`;
  if (AUDIO_EXTS.has(e)) return `${e.toUpperCase()} 오디오`;
  if (ARCHIVE_EXTS.has(e)) return `${e.toUpperCase()} 아카이브`;
  return `${e.toUpperCase()} 파일`;
}

export function isImage(entry) { return !entry.isDir && IMAGE_EXTS.has(entry.ext); }
export function isTextLike(entry) {
  return !entry.isDir && (TEXT_EXTS.has(entry.ext) || CODE_EXTS.has(entry.ext));
}
export function isVideo(entry) { return !entry.isDir && VIDEO_EXTS.has(entry.ext); }
export function isAudio(entry) { return !entry.isDir && AUDIO_EXTS.has(entry.ext); }

export function localFileUrl(p) {
  return 'localfile://' + encodeURIComponent(p);
}

export function sortEntries(entries, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    // folders always first (Explorer style)
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let r = 0;
    if (key === 'name') r = a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
    else if (key === 'mtime') r = a.mtime - b.mtime;
    else if (key === 'size') r = a.size - b.size;
    else if (key === 'kind') r = fileKind(a).localeCompare(fileKind(b), 'ko') || a.name.localeCompare(b.name, 'ko', { numeric: true });
    return r * mul;
  });
}

let idCounter = 1;
export function nextId() { return String(idCounter++); }
