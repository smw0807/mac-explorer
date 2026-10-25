import { useState, useCallback, useEffect, useRef } from 'react';
import ContextMenu from './ContextMenu.jsx';
import { acceptsDrop, dropToDir, extractDropPaths } from '../dnd.js';

function dropTargetProps(destPath, setDropTarget) {
  return {
    onDragOver: (e) => {
      if (!acceptsDrop(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
      setDropTarget(destPath);
    },
    onDragLeave: () => setDropTarget((v) => (v === destPath ? null : v)),
    onDrop: async (e) => {
      e.preventDefault();
      setDropTarget(null);
      await dropToDir(e, destPath);
    },
  };
}

function isWithin(parent, candidate) {
  return parent === candidate || candidate.startsWith(parent === '/' ? '/' : `${parent}/`);
}

function TreeNode({ node, depth, expanded, childrenMap, onToggle, onRetry, onNavigate, currentPath, dropTarget, setDropTarget }) {
  const isOpen = expanded.has(node.path);
  const listing = childrenMap[node.path];
  const children = listing?.children;
  const isCurrent = currentPath === node.path;

  return (
    <div>
      <div
        className={`tree-row ${isCurrent ? 'current' : ''} ${dropTarget === node.path ? 'drag-over' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onNavigate(node.path)}
        {...dropTargetProps(node.path, setDropTarget)}
      >
        <span
          className={`tree-arrow ${isOpen ? 'open' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
        >
          ▸
        </span>
        <span className="tree-icon">📁</span>
        <span className="tree-name" title={node.name}>{node.name}</span>
      </div>
      {isOpen && children && children.map((c) => (
        <TreeNode
          key={c.path}
          node={c}
          depth={depth + 1}
          expanded={expanded}
          childrenMap={childrenMap}
          onToggle={onToggle}
          onRetry={onRetry}
          onNavigate={onNavigate}
          currentPath={currentPath}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
        />
      ))}
      {isOpen && listing?.loading && (
        <div className="tree-loading" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>…</div>
      )}
      {isOpen && listing?.error && (
        <div className="tree-loading tree-error" role="alert" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
          <span title={listing.error}>폴더를 읽지 못했습니다.</span>
          <button className="tree-retry" onClick={() => onRetry(node.path)} aria-label={`${node.name} 다시 시도`}>다시 시도</button>
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ special, onNavigate, currentPath, favorites, onAddFavorite, onRemoveFavorite }) {
  const [expanded, setExpanded] = useState(new Set());
  const [childrenMap, setChildrenMap] = useState({});
  const [dropTarget, setDropTarget] = useState(null);
  const [menu, setMenu] = useState(null); // {x, y, items}
  const expandedRef = useRef(expanded);
  const childrenRef = useRef(childrenMap);
  const requestsRef = useRef(new Map());
  const mountedRef = useRef(true);

  const updateChildren = useCallback((next) => {
    childrenRef.current = next;
    setChildrenMap(next);
  }, []);

  // Closing or removing a branch also invalidates every outstanding child read.
  const clearBranches = useCallback((paths) => {
    if (!paths.length) return;
    const belongs = (p) => paths.some((branch) => isWithin(branch, p));
    const nextExpanded = new Set([...expandedRef.current].filter((p) => !belongs(p)));
    expandedRef.current = nextExpanded;
    setExpanded(nextExpanded);
    for (const p of requestsRef.current.keys()) {
      if (belongs(p)) requestsRef.current.delete(p);
    }
    updateChildren(Object.fromEntries(Object.entries(childrenRef.current).filter(([p]) => !belongs(p))));
  }, [updateChildren]);

  const loadChildren = useCallback(async (p) => {
    if (!mountedRef.current || !expandedRef.current.has(p)) return;
    const request = {};
    requestsRef.current.set(p, request);
    updateChildren({ ...childrenRef.current, [p]: { children: childrenRef.current[p]?.children, loading: true, error: null } });
    let res;
    try {
      res = await window.api.readDir(p);
    } catch (error) {
      res = { ok: false, error: error.message || String(error) };
    }
    if (!mountedRef.current || !expandedRef.current.has(p) || requestsRef.current.get(p) !== request) return;
    requestsRef.current.delete(p);
    if (!res.ok) {
      clearBranches((childrenRef.current[p]?.children || []).map((child) => child.path));
      updateChildren({ ...childrenRef.current, [p]: { children: null, loading: false, error: res.error || '폴더를 읽을 수 없습니다.' } });
      return;
    }
    const dirs = res.entries
      .filter((e) => e.isDir && !e.hidden && !e.name.endsWith('.app'))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
      .map((e) => ({ name: e.name, path: e.path }));
    const remaining = new Set(dirs.map((child) => child.path));
    clearBranches((childrenRef.current[p]?.children || []).filter((child) => !remaining.has(child.path)).map((child) => child.path));
    updateChildren({ ...childrenRef.current, [p]: { children: dirs, loading: false, error: null } });
  }, [clearBranches, updateChildren]);

  const onToggle = useCallback((p) => {
    if (expandedRef.current.has(p)) {
      clearBranches([p]);
      return;
    }
    const next = new Set(expandedRef.current).add(p);
    expandedRef.current = next;
    setExpanded(next);
    loadChildren(p);
  }, [clearBranches, loadChildren]);

  useEffect(() => {
    mountedRef.current = true;
    const requests = requestsRef.current;
    const refresh = (dirs) => {
      if (!mountedRef.current || !Array.isArray(dirs)) return;
      const changed = dirs.filter((dir) => typeof dir === 'string' && dir.startsWith('/')).map((dir) => dir.replace(/\/+$/, '') || '/');
      for (const p of expandedRef.current) {
        if (changed.some((dir) => isWithin(dir, p) || isWithin(p, dir))) loadChildren(p);
      }
    };
    const onChanged = (event) => refresh(event.detail?.dirs);
    window.addEventListener('mx-fs-changed', onChanged);
    const off = window.api.onDirChanged(({ dir }) => refresh([dir]));
    return () => {
      mountedRef.current = false;
      requests.clear();
      window.removeEventListener('mx-fs-changed', onChanged);
      off();
    };
  }, [loadChildren]);

  if (!special || !favorites) return <aside className="sidebar" />;

  const roots = [
    { name: '홈', path: special.home },
    { name: 'Macintosh HD', path: '/' },
    ...special.volumes
      .filter((v) => v.path !== '/' && v.name !== 'Macintosh HD')
      .map((v) => ({ name: v.name, path: v.path })),
  ];

  return (
    <aside className="sidebar">
      <div
        className={`sb-section ${dropTarget === '__favorites__' ? 'drag-over' : ''}`}
        title="폴더를 끌어다 놓으면 즐겨찾기에 추가"
        onDragOver={(e) => {
          if (!acceptsDrop(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropTarget('__favorites__');
        }}
        onDragLeave={() => setDropTarget((v) => (v === '__favorites__' ? null : v))}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(null);
          extractDropPaths(e).forEach((p) => onAddFavorite(p));
        }}
      >즐겨찾기</div>
      {favorites.map((f) => (
        <div
          key={f.path}
          className={`sb-item ${currentPath === f.path ? 'current' : ''} ${dropTarget === f.path ? 'drag-over' : ''}`}
          onClick={() => onNavigate(f.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({
              x: e.clientX, y: e.clientY,
              items: [{ label: '즐겨찾기에서 제거', onClick: () => onRemoveFavorite(f.path) }],
            });
          }}
          {...dropTargetProps(f.path, setDropTarget)}
        >
          <span className="sb-icon">{f.icon}</span>
          <span>{f.name}</span>
        </div>
      ))}
      <div className="sb-section">폴더 트리</div>
      <div className="sb-tree">
        {roots.map((r) => (
          <TreeNode
            key={r.path}
            node={r}
            depth={0}
            expanded={expanded}
            childrenMap={childrenMap}
            onToggle={onToggle}
            onRetry={loadChildren}
            onNavigate={onNavigate}
            currentPath={currentPath}
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
          />
        ))}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
