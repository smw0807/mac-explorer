import React, { useState, useCallback } from 'react';

function TreeNode({ node, depth, expanded, childrenMap, onToggle, onNavigate, currentPath }) {
  const isOpen = expanded.has(node.path);
  const children = childrenMap[node.path];
  const isCurrent = currentPath === node.path;

  return (
    <div>
      <div
        className={`tree-row ${isCurrent ? 'current' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onNavigate(node.path)}
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
        />
      ))}
      {isOpen && !children && (
        <div className="tree-loading" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>…</div>
      )}
    </div>
  );
}

export default function Sidebar({ special, onNavigate, currentPath }) {
  const [expanded, setExpanded] = useState(new Set());
  const [childrenMap, setChildrenMap] = useState({});

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

  if (!special) return <aside className="sidebar" />;

  const favorites = [
    { icon: '🏠', name: '홈', path: special.home },
    { icon: '🖥️', name: '데스크탑', path: special.desktop },
    { icon: '📄', name: '문서', path: special.documents },
    { icon: '⬇️', name: '다운로드', path: special.downloads },
    { icon: '🖼️', name: '사진', path: special.pictures },
    { icon: '🅰️', name: '응용 프로그램', path: special.applications },
  ];

  const roots = [
    { name: '홈', path: special.home },
    { name: 'Macintosh HD', path: '/' },
    ...special.volumes
      .filter((v) => v.path !== '/' && v.name !== 'Macintosh HD')
      .map((v) => ({ name: v.name, path: v.path })),
  ];

  return (
    <aside className="sidebar">
      <div className="sb-section">즐겨찾기</div>
      {favorites.map((f) => (
        <div
          key={f.path}
          className={`sb-item ${currentPath === f.path ? 'current' : ''}`}
          onClick={() => onNavigate(f.path)}
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
          />
        ))}
      </div>
    </aside>
  );
}
