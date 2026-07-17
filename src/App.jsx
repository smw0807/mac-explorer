import React, { useState, useEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Pane from './components/Pane.jsx';
import { basename, nextId } from './util.js';
import { undoLast } from './undo.js';

function makePane(path) { return { id: nextId(), initialPath: path }; }
function makeTab(path) { return { id: nextId(), dual: false, panes: [makePane(path)] }; }

function defaultFavorites(sp) {
  return [
    { icon: '🏠', name: '홈', path: sp.home },
    { icon: '🖥️', name: '데스크탑', path: sp.desktop },
    { icon: '📄', name: '문서', path: sp.documents },
    { icon: '⬇️', name: '다운로드', path: sp.downloads },
    { icon: '🖼️', name: '사진', path: sp.pictures },
    { icon: '🅰️', name: '응용 프로그램', path: sp.applications },
  ];
}

export default function App() {
  const [special, setSpecial] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [activePaneId, setActivePaneId] = useState(null);
  const [clipboard, setClipboard] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [panePaths, setPanePaths] = useState({});
  const [favorites, setFavorites] = useState(null);
  const navigators = useRef({});
  const saveTimer = useRef(null);

  useEffect(() => {
    (async () => {
      const res = await window.api.specialDirs();
      const st = (await window.api.settingsGet()).settings || {};
      setFavorites(Array.isArray(st.favorites) && st.favorites.length ? st.favorites : defaultFavorites(res));

      // 이전 세션 탭 복원 (존재하는 경로만)
      let restored = [];
      for (const t of st.session?.tabs || []) {
        const paths = [];
        for (const p of (t.paths || []).slice(0, 2)) {
          const ex = await window.api.exists(p);
          if (ex.exists && ex.isDir) paths.push(p);
        }
        if (paths.length) {
          const dual = !!t.dual && paths.length > 1;
          restored.push({ id: nextId(), dual, panes: paths.slice(0, dual ? 2 : 1).map((p) => makePane(p)) });
        }
      }
      if (!restored.length) restored = [makeTab(res.home)];
      const act = restored[Math.min(st.session?.active ?? 0, restored.length - 1)];
      setSpecial(res);
      setTabs(restored);
      setActiveTabId(act.id);
      setActivePaneId(act.panes[0].id);
      if (st.session?.showHidden) setShowHidden(true);
    })();
  }, []);

  // 세션(탭/경로/듀얼/숨김) 저장 — 변경 후 500ms 디바운스
  useEffect(() => {
    if (!special || !tabs.length) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      window.api.settingsSet({
        session: {
          tabs: tabs.map((t) => ({
            dual: t.dual,
            paths: t.panes.map((p) => panePaths[p.id] || p.initialPath),
          })),
          active: Math.max(0, tabs.findIndex((t) => t.id === activeTabId)),
          showHidden,
        },
      });
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [tabs, activeTabId, panePaths, showHidden, special]);

  const addFavorite = useCallback(async (p) => {
    const ex = await window.api.exists(p);
    if (!ex.exists || !ex.isDir) return;
    setFavorites((prev) => {
      if (prev.some((f) => f.path === p)) return prev;
      const next = [...prev, { icon: '📁', name: basename(p), path: p }];
      window.api.settingsSet({ favorites: next });
      return next;
    });
  }, []);

  const removeFavorite = useCallback((p) => {
    setFavorites((prev) => {
      const next = prev.filter((f) => f.path !== p);
      window.api.settingsSet({ favorites: next });
      return next;
    });
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const registerNavigator = useCallback((paneId, fn) => {
    navigators.current[paneId] = fn;
  }, []);

  const onPathChange = useCallback((paneId, path) => {
    setPanePaths((prev) => (prev[paneId] === path ? prev : { ...prev, [paneId]: path }));
  }, []);

  const addTab = useCallback((path) => {
    const t = makeTab(path);
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.id);
    setActivePaneId(t.panes[0].id);
  }, []);

  const closeTab = useCallback((tabId) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      if (tabId === activeTabId) {
        const fallback = next[Math.max(0, idx - 1)];
        setActiveTabId(fallback.id);
        setActivePaneId(fallback.panes[0].id);
      }
      return next;
    });
  }, [activeTabId]);

  const selectTab = useCallback((tab) => {
    setActiveTabId(tab.id);
    setActivePaneId(tab.panes[0].id);
  }, []);

  const toggleDual = useCallback(() => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== activeTabId) return t;
      if (t.dual) {
        setActivePaneId(t.panes[0].id);
        return { ...t, dual: false, panes: [t.panes[0]] };
      }
      const currentPath = panePaths[t.panes[0].id] || special?.home || '/';
      return { ...t, dual: true, panes: [t.panes[0], makePane(currentPath)] };
    }));
  }, [activeTabId, panePaths, special]);

  // global shortcuts
  useEffect(() => {
    function onKey(e) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 't') { e.preventDefault(); addTab(panePaths[activePaneId] || special?.home || '/'); }
      else if (e.key === 'w') { e.preventDefault(); closeTab(activeTabId); }
      // with Shift held, e.key is the shifted character ('D', '>') — compare case-insensitively / by code
      else if (e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); toggleDual(); }
      else if (e.shiftKey && (e.key === '.' || e.code === 'Period')) { e.preventDefault(); setShowHidden((v) => !v); }
      else if (e.key.toLowerCase() === 'z' && !e.shiftKey
        && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        undoLast();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addTab, closeTab, toggleDual, activeTabId, activePaneId, panePaths, special]);

  const sidebarNavigate = useCallback((path) => {
    const fn = navigators.current[activePaneId];
    if (fn) fn(path);
  }, [activePaneId]);

  if (!special) return <div className="app loading-app">불러오는 중…</div>;

  return (
    <div className="app">
      <div className="titlebar">
        <div className="tabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === activeTabId ? 'active' : ''}`}
              onClick={() => selectTab(t)}
            >
              <span className="tab-title">
                {basename(panePaths[t.panes[0].id] || '') || '새 탭'}
                {t.dual ? ' ⧉' : ''}
              </span>
              {tabs.length > 1 && (
                <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>✕</span>
              )}
            </div>
          ))}
          <button className="tab-add" onClick={() => addTab(panePaths[activePaneId] || special.home)} title="새 탭 (⌘T)">＋</button>
        </div>
        <div className="titlebar-actions">
          <button
            className={`tb-btn ${activeTab?.dual ? 'on' : ''}`}
            onClick={toggleDual}
            title="듀얼 패널 (⇧⌘D)"
          >⧉</button>
          <button
            className={`tb-btn ${showHidden ? 'on' : ''}`}
            onClick={() => setShowHidden((v) => !v)}
            title="숨김 파일 표시 (⇧⌘.)"
          >👓</button>
        </div>
      </div>

      <div className="body">
        <Sidebar
          special={special}
          onNavigate={sidebarNavigate}
          currentPath={panePaths[activePaneId]}
          favorites={favorites}
          onAddFavorite={addFavorite}
          onRemoveFavorite={removeFavorite}
        />
        <div className={`panes ${activeTab?.dual ? 'dual' : ''}`}>
          {activeTab?.panes.map((pane) => (
            <Pane
              key={pane.id}
              paneId={pane.id}
              initialPath={pane.initialPath}
              active={pane.id === activePaneId}
              onActivate={() => setActivePaneId(pane.id)}
              clipboard={clipboard}
              setClipboard={setClipboard}
              showHidden={showHidden}
              registerNavigator={registerNavigator}
              onPathChange={onPathChange}
              onOpenInNewTab={addTab}
              special={special}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
