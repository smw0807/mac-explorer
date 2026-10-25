import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ContextMenu from './ContextMenu.jsx';
import FileIcon from './FileIcon.jsx';
import BatchRenameDialog from './BatchRenameDialog.jsx';
import {
  basename, parentPath, formatSize, formatDate, fileIcon, fileKind,
  sortEntries, isImage, isTextLike, isVideo, isAudio, localFileUrl,
} from '../util.js';
import { acceptsDrop, startDrag, dropToDir, notifyFsChanged, resolveConflictMode } from '../dnd.js';
import { recordOp } from '../undo.js';

function Preview({ entry }) {
  const [content, setContent] = useState(null);
  useEffect(() => {
    let alive = true;
    setContent(null);
    if (entry && isTextLike(entry)) {
      (async () => {
        try {
          const result = await window.api.readText(entry.path);
          if (alive) setContent({ path: entry.path, text: result.text, error: result.ok ? null : result.error || '파일을 읽을 수 없습니다.' });
        } catch (error) {
          if (alive) setContent({ path: entry.path, error: error.message || String(error) });
        }
      })();
    }
    return () => { alive = false; };
  }, [entry?.path, entry?.mtime]);

  if (!entry) return <div className="preview empty">항목을 선택하면 미리보기가 표시됩니다</div>;

  let body;
  if (isImage(entry)) body = <img src={localFileUrl(entry.path)} alt={entry.name} />;
  else if (isVideo(entry)) body = <video src={localFileUrl(entry.path)} controls />;
  else if (isAudio(entry)) body = <audio src={localFileUrl(entry.path)} controls />;
  else if (isTextLike(entry)) {
    const current = content?.path === entry.path ? content : null;
    body = current?.error
      ? <div className="fl-error" role="status">미리보기 실패: {current.error}</div>
      : <pre>{current?.text ?? '불러오는 중…'}</pre>;
  }
  else body = <div className="preview-bigicon">{fileIcon(entry)}</div>;

  return (
    <div className="preview">
      {body}
      <div className="preview-meta">
        <div className="preview-name" title={entry.name}>{entry.name}</div>
        <div>{fileKind(entry)}{entry.isDir ? '' : ` · ${formatSize(entry.size) || '0 B'}`}</div>
        <div>{formatDate(entry.mtime)}</div>
      </div>
    </div>
  );
}

export default function Pane({
  paneId, initialPath, active, onActivate,
  clipboard, setClipboard, startCopy, showHidden,
  registerNavigator, onPathChange, onOpenInNewTab, special,
}) {
  const [hist, setHist] = useState({ stack: [initialPath], idx: 0 });
  const path = hist.stack[hist.idx];
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [watchError, setWatchError] = useState(null);
  const [selection, setSelection] = useState(() => new Set());
  const anchorRef = useRef(-1);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [filter, setFilter] = useState('');
  const [deepSearch, setDeepSearch] = useState(null); // {query, results, searching}
  const [renaming, setRenaming] = useState(null); // path
  const [renameValue, setRenameValue] = useState('');
  const [addressEdit, setAddressEdit] = useState(false);
  const [addressValue, setAddressValue] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [view, setView] = useState('list'); // 'list' | 'grid'
  const [menu, setMenu] = useState(null); // {x, y, items}
  const [disk, setDisk] = useState(null);
  const [dragOver, setDragOver] = useState(null); // folder path or '' (pane background)
  const [batchRename, setBatchRename] = useState(false);
  const rootRef = useRef(null);
  const addressInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const typeAheadRef = useRef({ s: '', t: 0 });
  const mountedRef = useRef(true);
  const currentPathRef = useRef(initialPath);
  const loadGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const watchGeneration = useRef(0);
  const currentSearch = useRef(null);
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGeneration.current += 1;
      searchGeneration.current += 1;
      watchGeneration.current += 1;
    };
  }, []);

  const clearSearch = useCallback((nextFilter = '') => {
    searchGeneration.current += 1;
    currentSearch.current = null;
    setDeepSearch(null);
    setFilter(nextFilter);
  }, []);

  const resetNavigation = useCallback((nextPath) => {
    if (currentPathRef.current !== nextPath) {
      // Invalidate synchronously, before React commits the new path/effects.
      currentPathRef.current = nextPath;
      loadGeneration.current += 1;
      watchGeneration.current += 1;
      setEntries([]);
      setError(null);
      setWatchError(null);
      setDisk(null);
    }
    clearSearch();
    setSelection(new Set());
    anchorRef.current = -1;
    setAddressEdit(false);
    setAddressValue('');
    setRenaming(null);
    setMenu(null);
  }, [clearSearch]);

  const navigate = useCallback((p) => {
    resetNavigation(p);
    setHist((h) => {
      if (h.stack[h.idx] === p) return h;
      const stack = h.stack.slice(0, h.idx + 1).concat(p);
      return { stack, idx: stack.length - 1 };
    });
  }, [resetNavigation]);

  const moveHistory = useCallback((delta) => {
    const idx = hist.idx + delta;
    if (idx < 0 || idx >= hist.stack.length) return;
    resetNavigation(hist.stack[idx]);
    setHist((previous) => ({ ...previous, idx }));
  }, [hist, resetNavigation]);

  useEffect(() => {
    registerNavigator(paneId, navigate);
    return () => registerNavigator(paneId, null);
  }, [paneId, navigate, registerNavigator]);
  useEffect(() => { onPathChange(paneId, path); }, [paneId, path, onPathChange]);

  const load = useCallback(async () => {
    if (!mountedRef.current || path !== currentPathRef.current) return false;
    const generation = ++loadGeneration.current;
    const isCurrent = () => mountedRef.current && generation === loadGeneration.current && path === currentPathRef.current;
    let res;
    try {
      res = await window.api.readDir(path);
    } catch (error) {
      res = { ok: false, error: error.message || String(error) };
    }
    if (!isCurrent()) return false;
    if (res.ok) { setEntries(res.entries); setError(null); }
    else { setEntries([]); setError(res.error); }
    try {
      const d = await window.api.statfs(path);
      if (isCurrent()) setDisk(d.ok ? d : null);
    } catch {
      if (isCurrent()) setDisk(null);
    }
    return isCurrent() && res.ok;
  }, [path]);

  useEffect(() => { load(); }, [load]);

  // 다른 패널/사이드바에서 일어난 파일 작업 반영
  useEffect(() => {
    function onChanged(e) {
      if (e.detail.dirs.includes(path)) load();
    }
    window.addEventListener('mx-fs-changed', onChanged);
    return () => window.removeEventListener('mx-fs-changed', onChanged);
  }, [path, load]);

  const startWatching = useCallback(async () => {
    if (!mountedRef.current || path !== currentPathRef.current) return;
    const generation = ++watchGeneration.current;
    let result;
    try {
      result = await window.api.watchDir(paneId, path);
    } catch (error) {
      result = { ok: false, error: error.message || String(error) };
    }
    if (!mountedRef.current || generation !== watchGeneration.current || path !== currentPathRef.current) return;
    setWatchError(result.ok ? null : result.error || '폴더를 감시할 수 없습니다.');
  }, [paneId, path]);

  // Subscribe before starting the watcher so an immediate failure is not missed.
  useEffect(() => {
    const off = window.api.onDirChanged(({ paneId: id, dir, error }) => {
      if (!mountedRef.current || id !== paneId || dir !== path || path !== currentPathRef.current) return;
      if (error != null) {
        watchGeneration.current += 1;
        setWatchError(error || '폴더 감시가 중단되었습니다.');
      } else load();
    });
    startWatching();
    return () => {
      watchGeneration.current += 1;
      off();
      window.api.unwatchDir(paneId);
    };
  }, [paneId, path, load, startWatching]);

  const refresh = useCallback(() => {
    load();
    if (watchError) startWatching();
  }, [load, watchError, startWatching]);

  const displayed = useMemo(() => {
    let base = deepSearch ? deepSearch.results : entries;
    if (!showHidden) base = base.filter((e) => !e.hidden);
    if (filter && !deepSearch) {
      const q = filter.toLowerCase();
      base = base.filter((e) => e.name.toLowerCase().includes(q));
    }
    return sortEntries(base, sort.key, sort.dir);
  }, [entries, deepSearch, showHidden, filter, sort]);

  const selectedEntries = useMemo(
    () => displayed.filter((e) => selection.has(e.path)),
    [displayed, selection]
  );
  const selectedPaths = useMemo(() => selectedEntries.map((entry) => entry.path), [selectedEntries]);

  useEffect(() => {
    const visible = new Set(displayed.map((entry) => entry.path));
    setSelection((previous) => {
      const next = new Set([...previous].filter((p) => visible.has(p)));
      return next.size === previous.size ? previous : next;
    });
  }, [displayed]);

  useEffect(() => {
    setMenu(null);
    anchorRef.current = -1;
  }, [filter, showHidden, deepSearch]);

  /* ---------- actions ---------- */

  const openEntry = useCallback((entry) => {
    if (entry.isDir && !entry.name.endsWith('.app')) navigate(entry.path);
    else window.api.open(entry.path);
  }, [navigate]);

  const doCopy = useCallback(() => {
    if (selectedPaths.length) setClipboard({ mode: 'copy', paths: selectedPaths });
  }, [selectedPaths, setClipboard]);

  const doCut = useCallback(() => {
    if (selectedPaths.length) setClipboard({ mode: 'cut', paths: selectedPaths });
  }, [selectedPaths, setClipboard]);

  const doPaste = useCallback(async () => {
    if (!clipboard) return;
    const opts = await resolveConflictMode(clipboard.paths, path);
    if (!opts) return; // 사용자가 취소
    if (clipboard.mode === 'copy') {
      await startCopy(clipboard.paths, path, opts);
      return;
    }
    const res = await window.api.move(clipboard.paths, path, opts);
    const recoverySources = new Set((res.recovery || []).map((item) => item.from));
    const moved = (res.items || []).filter((item) => !recoverySources.has(item.from));
    if (moved.length) recordOp({ type: 'move', items: moved });
    const completed = new Set([...moved.map((item) => item.from), ...recoverySources]);
    if (completed.size) {
      setClipboard((previous) => {
        if (previous !== clipboard) return previous;
        const paths = previous.paths.filter((p) => !completed.has(p));
        return paths.length ? { ...previous, paths } : null;
      });
    }
    notifyFsChanged([...new Set([path, ...clipboard.paths.map(parentPath)])]);
    if (!res.ok) alert(res.error);
  }, [clipboard, path, setClipboard, startCopy]);

  const trashPaths = useCallback(async (paths) => {
    if (!paths.length) return;
    const res = await window.api.trash(paths);
    const trashed = new Set(res.trashed || (res.ok ? paths : []));
    if (trashed.size) {
      setSelection((previous) => new Set([...previous].filter((p) => !trashed.has(p))));
      notifyFsChanged([...new Set([...trashed].map(parentPath))]);
    }
    if (!res.ok) alert(res.error);
  }, []);

  const doTrash = useCallback(() => trashPaths(selectedPaths), [selectedPaths, trashPaths]);

  const startRename = useCallback(() => {
    const first = selectedEntries[0];
    if (!first) return;
    setRenaming(first.path);
    setRenameValue(first.name);
  }, [selectedEntries]);

  const commitRename = useCallback(async () => {
    if (!renaming) return;
    const oldName = basename(renaming);
    if (renameValue && renameValue !== oldName) {
      const res = await window.api.rename(renaming, renameValue);
      if (!res.ok) alert(res.error);
      else recordOp({ type: 'rename', from: renaming, to: res.path });
    }
    setRenaming(null);
    load();
  }, [renaming, renameValue, load]);

  const newFolder = useCallback(async () => {
    const res = await window.api.mkdir(path, '새 폴더');
    if (res.ok) {
      recordOp({ type: 'create', path: res.path });
      await load();
      if (!mountedRef.current || path !== currentPathRef.current) return;
      setSelection(new Set([res.path]));
      setRenaming(res.path);
      setRenameValue(basename(res.path));
    } else alert(res.error);
  }, [path, load]);

  const newFile = useCallback(async () => {
    const res = await window.api.newFile(path, '새 파일.txt');
    if (res.ok) {
      recordOp({ type: 'create', path: res.path });
      await load();
      if (!mountedRef.current || path !== currentPathRef.current) return;
      setSelection(new Set([res.path]));
      setRenaming(res.path);
      setRenameValue(basename(res.path));
    } else alert(res.error);
  }, [path, load]);

  const applyBatchRename = useCallback(async (renames) => {
    const items = [];
    for (const { from, to } of renames) {
      if (basename(from) === to) continue;
      const res = await window.api.rename(from, to);
      if (!res.ok) { alert(res.error); break; }
      items.push({ from, to: res.path });
    }
    if (items.length) recordOp({ type: 'renameBatch', items });
    setBatchRename(false);
    setSelection(new Set());
    load();
  }, [load]);

  const runSearch = useCallback(async (query, spotlight = false) => {
    if (!query) { clearSearch(); return; }
    const generation = ++searchGeneration.current;
    const request = { query, spotlight, path: currentPathRef.current, showHidden: showHiddenRef.current };
    currentSearch.current = request;
    setDeepSearch({ query, spotlight, results: [], searching: true });
    let result;
    try {
      const search = spotlight ? window.api.searchSpotlight : window.api.search;
      result = await search(request.path, query, { showHidden: request.showHidden });
    } catch (error) {
      result = { ok: false, error: error.message || String(error) };
    }
    if (!mountedRef.current || generation !== searchGeneration.current
      || request.path !== currentPathRef.current || request.showHidden !== showHiddenRef.current) return;
    setDeepSearch({
      query, spotlight, results: result.ok ? result.entries : [], searching: false,
      truncated: !!result.truncated, error: result.ok ? null : result.error || '검색할 수 없습니다.',
    });
  }, [clearSearch]);

  useEffect(() => {
    const request = currentSearch.current;
    if (request && request.showHidden !== showHidden) runSearch(request.query, request.spotlight);
  }, [showHidden, runSearch]);

  /* ---------- drag & drop ---------- */

  const handleDragStart = useCallback((e, entry) => {
    const paths = selectedPaths.includes(entry.path) ? selectedPaths : [entry.path];
    if (!selection.has(entry.path)) setSelection(new Set([entry.path]));
    startDrag(e, paths);
  }, [selection, selectedPaths]);

  const handleDropOn = useCallback(async (e, destDir) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    await dropToDir(e, destDir);
  }, []);

  /* ---------- selection ---------- */

  const handleRowClick = useCallback((e, entry, idx) => {
    e.stopPropagation();
    onActivate();
    if (e.shiftKey && anchorRef.current >= 0) {
      const [a, b] = [anchorRef.current, idx].sort((x, y) => x - y);
      setSelection(new Set(displayed.slice(a, b + 1).map((x) => x.path)));
    } else if (e.metaKey || e.ctrlKey) {
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      anchorRef.current = idx;
    } else {
      setSelection(new Set([entry.path]));
      anchorRef.current = idx;
    }
  }, [displayed, onActivate]);

  const handleRowContext = useCallback((e, entry) => {
    e.preventDefault();
    e.stopPropagation();
    onActivate();
    let sel = new Set(selectedPaths);
    if (!selection.has(entry.path)) {
      sel = new Set([entry.path]);
      setSelection(sel);
    }
    const multi = sel.size > 1;
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: '열기', onClick: () => openEntry(entry) },
        ...(entry.isDir ? [{ label: '새 탭에서 열기', onClick: () => onOpenInNewTab(entry.path) }] : []),
        ...(!entry.isDir && !multi ? [{ label: '다음으로 열기…', onClick: async () => {
            const r = await window.api.pickApp();
            if (!r.ok || !r.path) return;
            const res = await window.api.openWithApp(entry.path, r.path);
            if (!res.ok) alert(res.error);
          } }] : []),
        { label: 'Finder에서 보기', onClick: () => window.api.reveal(entry.path) },
        { label: 'Quick Look', shortcut: '⌘Y', onClick: () => window.api.quickLook(entry.path) },
        { separator: true },
        { label: '잘라내기', shortcut: '⌘X', onClick: () => setClipboard({ mode: 'cut', paths: [...sel] }) },
        { label: '복사', shortcut: '⌘C', onClick: () => setClipboard({ mode: 'copy', paths: [...sel] }) },
        { label: '붙여넣기', shortcut: '⌘V', disabled: !clipboard, onClick: doPaste },
        { separator: true },
        { label: '이름 바꾸기', shortcut: 'F2', disabled: multi, onClick: () => { setRenaming(entry.path); setRenameValue(entry.name); } },
        ...(multi ? [{ label: '일괄 이름 변경…', onClick: () => setBatchRename(true) }] : []),
        { label: '휴지통으로 이동', shortcut: '⌘⌫', onClick: () => trashPaths([...sel]) },
        { separator: true },
        { label: '압축하기', onClick: async () => {
            const res = await window.api.compress([...sel]);
            if (!res.ok) alert(res.error);
            else recordOp({ type: 'create', path: res.path });
            load();
          } },
        ...(!multi && entry.ext === 'zip' ? [{ label: '압축 해제', onClick: async () => {
            const res = await window.api.extract(entry.path);
            if (!res.ok) alert(res.error);
            else recordOp({ type: 'create', path: res.path });
            load();
          } }] : []),
        { separator: true },
        { label: '경로 복사', onClick: () => window.api.copyTextToClipboard([...sel].join('\n')) },
      ],
    });
  }, [selection, selectedPaths, clipboard, openEntry, doPaste, load, onActivate, onOpenInNewTab, setClipboard, trashPaths]);

  const handleEmptyContext = useCallback((e) => {
    e.preventDefault();
    onActivate();
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: '새 폴더', shortcut: '⇧⌘N', onClick: newFolder },
        { label: '새 파일', onClick: newFile },
        { separator: true },
        { label: '붙여넣기', shortcut: '⌘V', disabled: !clipboard, onClick: doPaste },
        { separator: true },
        { label: '현재 경로 복사', onClick: () => window.api.copyTextToClipboard(path) },
        { label: '새로 고침', shortcut: '⌘R', onClick: refresh },
      ],
    });
  }, [clipboard, doPaste, newFolder, newFile, path, refresh, onActivate]);

  /* ---------- keyboard ---------- */

  const handleKeyDown = useCallback((e) => {
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    const meta = e.metaKey || e.ctrlKey;

    if (inInput) return;

    if (meta && e.key === 'a') { e.preventDefault(); setSelection(new Set(displayed.map((x) => x.path))); return; }
    if (meta && e.key === 'c') { e.preventDefault(); doCopy(); return; }
    if (meta && e.key === 'x') { e.preventDefault(); doCut(); return; }
    if (meta && e.key === 'v') { e.preventDefault(); doPaste(); return; }
    if (meta && e.key === 'r') { e.preventDefault(); refresh(); return; }
    if (meta && e.key === 'l') { e.preventDefault(); setAddressValue(path); setAddressEdit(true); return; }
    if (meta && e.key === 'f') { e.preventDefault(); searchInputRef.current?.focus(); return; }
    if (meta && e.key === 'y') { e.preventDefault(); selectedEntries[0] && window.api.quickLook(selectedEntries[0].path); return; }
    if (meta && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newFolder(); return; }
    if (meta && e.key === 'ArrowUp') { e.preventDefault(); if (path !== '/') navigate(parentPath(path)); return; }
    if (meta && e.key === 'ArrowDown') { e.preventDefault(); selectedEntries[0] && openEntry(selectedEntries[0]); return; }
    if (meta && e.key === 'Backspace') { e.preventDefault(); doTrash(); return; }
    if (e.key === 'Delete') { e.preventDefault(); doTrash(); return; }
    if (e.key === 'F2') { e.preventDefault(); startRename(); return; }
    if (e.key === 'Enter') { e.preventDefault(); selectedEntries[0] && openEntry(selectedEntries[0]); return; }
    if (e.key === ' ') { e.preventDefault(); setShowPreview((v) => !v); return; }
    if (e.key === 'Escape') { setSelection(new Set()); clearSearch(); return; }

    // 타이핑 점프: 연속 입력(700ms)한 글자로 시작하는 항목을 선택
    if (!meta && !e.altKey && e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      const now = Date.now();
      const buf = now - typeAheadRef.current.t < 700 ? typeAheadRef.current.s : '';
      const q = (buf + e.key).toLowerCase();
      typeAheadRef.current = { s: q, t: now };
      const idx = displayed.findIndex((x) => x.name.toLowerCase().startsWith(q));
      if (idx >= 0) {
        setSelection(new Set([displayed[idx].path]));
        anchorRef.current = idx;
        rootRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }

    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      const isGrid = view === 'grid';
      if (!isGrid && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault();
      if (!displayed.length) return;
      let cols = 1;
      if (isGrid) {
        const grid = rootRef.current?.querySelector('.fl-rows.grid');
        if (grid) cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      }
      const delta = e.key === 'ArrowDown' ? cols
        : e.key === 'ArrowUp' ? -cols
        : e.key === 'ArrowRight' ? 1 : -1;
      const cur = displayed.findIndex((x) => selection.has(x.path));
      let next;
      if (cur === -1) next = delta > 0 ? 0 : displayed.length - 1;
      else next = Math.min(displayed.length - 1, Math.max(0, cur + delta));
      setSelection(new Set([displayed[next].path]));
      anchorRef.current = next;
      rootRef.current?.querySelector(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [displayed, selection, selectedEntries, doCopy, doCut, doPaste, doTrash, startRename, openEntry, navigate, path, refresh, newFolder, view, clearSearch]);

  /* ---------- render ---------- */

  const segments = useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    const segs = [{ name: 'Macintosh HD', path: '/' }];
    let acc = '';
    for (const p of parts) { acc += '/' + p; segs.push({ name: p, path: acc }); }
    return segs;
  }, [path]);

  const entryClass = (entry, base) => [
    base,
    selection.has(entry.path) ? 'selected' : '',
    entry.hidden ? 'hidden-file' : '',
    clipboard?.mode === 'cut' && clipboard.paths.includes(entry.path) ? 'cut-pending' : '',
    dragOver === entry.path ? 'drag-over' : '',
  ].join(' ');

  // 리스트 행과 그리드 타일이 공유하는 인터랙션 props
  const entryProps = (entry, idx) => ({
    'data-idx': idx,
    onClick: (e) => handleRowClick(e, entry, idx),
    onDoubleClick: () => openEntry(entry),
    onContextMenu: (e) => handleRowContext(e, entry),
    draggable: renaming !== entry.path,
    onDragStart: (e) => handleDragStart(e, entry),
    ...(entry.isDir && !entry.name.endsWith('.app') ? {
      onDragOver: (e) => {
        if (!acceptsDrop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
        setDragOver(entry.path);
      },
      onDragLeave: () => setDragOver((v) => (v === entry.path ? null : v)),
      onDrop: (e) => handleDropOn(e, entry.path),
    } : {}),
  });

  const renameField = (
    <input
      className="rename-input"
      autoFocus
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onFocus={(e) => {
        const dot = e.target.value.lastIndexOf('.');
        e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
      }}
      onBlur={commitRename}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitRename();
        if (e.key === 'Escape') setRenaming(null);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );

  const sortHeader = (key, label, cls) => (
    <div
      className={`col ${cls} sortable`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))}
    >
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </div>
  );

  return (
    <div
      className={`pane ${active ? 'active' : ''}`}
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseDown={onActivate}
    >
      <div className="toolbar">
        <button className="tb-btn" disabled={hist.idx === 0}
          onClick={() => moveHistory(-1)}
          title="뒤로">◀</button>
        <button className="tb-btn" disabled={hist.idx >= hist.stack.length - 1}
          onClick={() => moveHistory(1)}
          title="앞으로">▶</button>
        <button className="tb-btn" disabled={path === '/'}
          onClick={() => navigate(parentPath(path))} title="상위 폴더">▲</button>
        <button className="tb-btn" onClick={refresh} title="새로 고침">⟳</button>

        {addressEdit ? (
          <input
            className="address-input"
            ref={addressInputRef}
            autoFocus
            value={addressValue}
            onChange={(e) => setAddressValue(e.target.value)}
            onBlur={() => setAddressEdit(false)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                let p = addressValue.trim().replace(/\/+$/, '') || '/';
                if (p.startsWith('~')) p = special.home + p.slice(1);
                const r = await window.api.exists(p);
                if (r.exists && r.isDir) navigate(p);
                else alert('폴더를 찾을 수 없습니다: ' + p);
              } else if (e.key === 'Escape') setAddressEdit(false);
            }}
          />
        ) : (
          <div className="breadcrumb" onClick={() => { setAddressValue(path); setAddressEdit(true); }}>
            {segments.map((s, i) => (
              <React.Fragment key={s.path}>
                {i > 0 && <span className="bc-sep">›</span>}
                <span
                  className="bc-seg"
                  onClick={(e) => { e.stopPropagation(); navigate(s.path); }}
                >
                  {s.name}
                </span>
              </React.Fragment>
            ))}
          </div>
        )}

        <input
          className="search-input"
          ref={searchInputRef}
          placeholder="검색 (Enter: 하위 폴더, ⌘Enter: Spotlight)"
          value={deepSearch ? deepSearch.query : filter}
          onChange={(e) => clearSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const q = e.target.value.trim();
              runSearch(q, e.metaKey);
            }
            if (e.key === 'Escape') { clearSearch(); e.target.blur(); }
          }}
        />
        <button
          className={`tb-btn ${view === 'grid' ? 'on' : ''}`}
          onClick={() => setView((v) => (v === 'list' ? 'grid' : 'list'))}
          title={view === 'list' ? '아이콘 보기' : '목록 보기'}
        >{view === 'list' ? '⊞' : '☰'}</button>
        <button
          className={`tb-btn ${showPreview ? 'on' : ''}`}
          onClick={() => setShowPreview((v) => !v)}
          title="미리보기 (Space)"
        >👁</button>
      </div>

      {watchError && (
        <div className="search-banner watch-status" role="status">
          자동 새로고침 중지: {watchError}
          <button onClick={refresh}>재시도</button>
        </div>
      )}

      {deepSearch && (
        <div className="search-banner">
          {deepSearch.searching
            ? `${deepSearch.spotlight ? 'Spotlight ' : ''}"${deepSearch.query}" 검색 중…`
            : deepSearch.error
              ? `검색 실패: ${deepSearch.error}`
              : `${deepSearch.spotlight ? 'Spotlight ' : ''}"${deepSearch.query}" 검색 결과 ${deepSearch.results.length}개${deepSearch.truncated ? ' · 일부 결과만 표시됩니다' : ''}`}
          <button onClick={() => clearSearch()}>✕ 닫기</button>
        </div>
      )}

      <div className="pane-body">
        <div
          className={`filelist ${dragOver === '' ? 'drag-over-bg' : ''}`}
          onContextMenu={handleEmptyContext}
          onClick={() => setSelection(new Set())}
          onDragOver={(e) => {
            if (!acceptsDrop(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
            setDragOver('');
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null);
          }}
          onDrop={(e) => handleDropOn(e, path)}
        >
          {view === 'list' && (
            <div className="fl-header">
              {sortHeader('name', '이름', 'col-name')}
              {sortHeader('mtime', '수정한 날짜', 'col-date')}
              {sortHeader('kind', '유형', 'col-kind')}
              {sortHeader('size', '크기', 'col-size')}
            </div>
          )}
          <div className={`fl-rows ${view === 'grid' ? 'grid' : ''}`}>
            {error && <div className="fl-error">⚠️ {error}</div>}
            {!error && displayed.length === 0 && (
              <div className="fl-empty">{deepSearch?.searching ? '검색 중…' : '비어 있는 폴더'}</div>
            )}
            {view === 'grid'
              ? displayed.map((entry, idx) => (
                <div key={entry.path} className={entryClass(entry, 'grid-item')} {...entryProps(entry, idx)}>
                  <div className="gi-thumb">
                    {isImage(entry) && entry.ext !== 'heic'
                      ? <img src={localFileUrl(entry.path)} loading="lazy" alt="" draggable={false} />
                      : <FileIcon entry={entry} size={48} className="gi-icon" />}
                  </div>
                  {renaming === entry.path ? renameField : (
                    <div className="gi-name" title={deepSearch ? entry.path : entry.name}>{entry.name}</div>
                  )}
                </div>
              ))
              : displayed.map((entry, idx) => (
                <div key={entry.path} className={entryClass(entry, 'fl-row')} {...entryProps(entry, idx)}>
                  <div className="col col-name">
                    <FileIcon entry={entry} size={16} />
                    {renaming === entry.path ? renameField : (
                      <span className="fl-name" title={deepSearch ? entry.path : entry.name}>{entry.name}</span>
                    )}
                  </div>
                  <div className="col col-date">{formatDate(entry.mtime)}</div>
                  <div className="col col-kind">{fileKind(entry)}</div>
                  <div className="col col-size">{entry.isDir ? '—' : formatSize(entry.size) || '0 B'}</div>
                </div>
              ))}
          </div>
        </div>
        {showPreview && <Preview entry={selectedEntries[0] || null} />}
      </div>

      <div className="statusbar">
        <span>{displayed.length}개 항목{selectedPaths.length > 0 ? ` · ${selectedPaths.length}개 선택됨` : ''}</span>
        <span>
          {clipboard ? `클립보드: ${clipboard.paths.length}개 (${clipboard.mode === 'cut' ? '잘라내기' : '복사'})` : ''}
          {disk ? `  여유 공간 ${formatSize(disk.free)}` : ''}
        </span>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {batchRename && (
        <BatchRenameDialog
          entries={selectedEntries}
          onCancel={() => setBatchRename(false)}
          onApply={applyBatchRename}
        />
      )}
    </div>
  );
}
