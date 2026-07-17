import React, { useState, useEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Pane from './components/Pane.jsx';
import { basename, nextId } from './util.js';

function makePane(path) { return { id: nextId(), initialPath: path }; }
function makeTab(path) { return { id: nextId(), dual: false, panes: [makePane(path)] }; }

export default function App() {
  const [special, setSpecial] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [activePaneId, setActivePaneId] = useState(null);
  const [clipboard, setClipboard] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [panePaths, setPanePaths] = useState({});
  const navigators = useRef({});

  useEffect(() => {
    window.api.specialDirs().then((res) => {
      setSpecial(res);
      const t = makeTab(res.home);
      setTabs([t]);
      setActiveTabId(t.id);
      setActivePaneId(t.panes[0].id);
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
      else if (e.shiftKey && e.key === 'd') { e.preventDefault(); toggleDual(); }
      else if (e.shiftKey && e.key === '.') { e.preventDefault(); setShowHidden((v) => !v); }
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
