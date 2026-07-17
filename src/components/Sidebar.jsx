import React, { useState, useCallback } from 'react';
import ContextMenu from './ContextMenu.jsx';
import { acceptsDrop, dropToDir, extractDropPaths } from '../dnd.js';

function dropTargetProps(destPath, dropTarget, setDropTarget) {
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

function TreeNode({ node, depth, expanded, childrenMap, onToggle, onNavigate, currentPath, dropTarget, setDropTarget }) {
  const isOpen = expanded.has(node.path);
  const children = childrenMap[node.path];
  const isCurrent = currentPath === node.path;

  return (
    <div>
      <div
        className={`tree-row ${isCurrent ? 'current' : ''} ${dropTarget === node.path ? 'drag-over' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onNavigate(node.path)}
        {...dropTargetProps(node.path, dropTarget, setDropTarget)}
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
          onNavigate={onNavigate}
          currentPath={currentPath}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
        />
      ))}
      {isOpen && !children && (
        <div className="tree-loading" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>…</div>
      )}
    </div>
  );
}

export default function Sidebar({ special, onNavigate, currentPath, favorites, onAddFavorite, onRemoveFavorite }) {
  const [expanded, setExpanded] = useState(new Set());
  const [childrenMap, setChildrenMap] = useState({});
  const [dropTarget, setDropTarget] = useState(null);
  const [menu, setMenu] = useState(null); // {x, y, items}

  const loadChildren = useCallback(async (p) => {
    const res = await window.api.readDir(p);
    if (!res.ok) { setChildrenMap((m) => ({ ...m, [p]: [] })); return; }
    const dirs = res.entries
      .filter((e) => e.isDir && !e.hidden && !e.name.endsWith('.app'))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
      .map((e) => ({ name: e.name, path: e.path }));
    setChildrenMap((m) => ({ ...m, [p]: dirs }));
  }, []);

  const onToggle = useCallback((p) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else {
        next.add(p);
        if (!childrenMap[p]) loadChildren(p);
      }
      return next;
    });
  }, [childrenMap, loadChildren]);

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
          {...dropTargetProps(f.path, dropTarget, setDropTarget)}
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
