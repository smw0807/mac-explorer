import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Pane from './components/Pane.jsx';
import { basename, formatSize, nextId } from './util.js';
import { undoLast } from './undo.js';
import useCopyJobs from './hooks/useCopyJobs.js';
import useSettingsPersistence from './hooks/useSettingsPersistence.js';

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
  const [initializationError, setInitializationError] = useState(null);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const navigators = useRef({});
  const mountedRef = useRef(true);
  const { jobs: copyJobs, startCopy, cancelCopy } = useCopyJobs();
  const settingsSnapshot = useMemo(() => {
    if (!special || !tabs.length || favorites == null) return null;
    return {
      favorites,
      session: {
        tabs: tabs.map((tab) => ({
          dual: tab.dual,
          paths: tab.panes.map((pane) => panePaths[pane.id] || pane.initialPath),
        })),
        active: Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId)),
        showHidden,
      },
    };
  }, [special, tabs, favorites, panePaths, activeTabId, showHidden]);
  const settings = useSettingsPersistence(settingsSnapshot);

  useEffect(() => {
    let alive = true;
    mountedRef.current = true;
    setInitializationError(null);
    (async () => {
      try {
        const res = await window.api.specialDirs();
        if (!alive) return;
        if (res.ok === false) throw new Error(res.error);
        const saved = await window.api.settingsGet();
        if (!alive) return;
        if (saved.ok === false) throw new Error(saved.error);
        const st = saved.settings || {};

        // 이전 세션 탭 복원 (존재하는 경로만)
        let restored = [];
        for (const t of st.session?.tabs || []) {
          const paths = [];
          for (const p of (t.paths || []).slice(0, 2)) {
            const ex = await window.api.exists(p);
            if (!alive) return;
            if (ex.exists && ex.isDir) paths.push(p);
          }
          if (paths.length) {
            const dual = !!t.dual && paths.length > 1;
            restored.push({ id: nextId(), dual, panes: paths.slice(0, dual ? 2 : 1).map((p) => makePane(p)) });
          }
        }
        if (!restored.length) restored = [makeTab(res.home)];
        const act = restored[Math.min(st.session?.active ?? 0, restored.length - 1)];
        setFavorites(Array.isArray(st.favorites) ? st.favorites : defaultFavorites(res));
        setSpecial(res);
        setTabs(restored);
        setActiveTabId(act.id);
        setActivePaneId(act.panes[0].id);
        setShowHidden(!!st.session?.showHidden);
      } catch (error) {
        if (alive) setInitializationError(error.message || String(error));
      }
    })();
    return () => { alive = false; mountedRef.current = false; };
  }, [initializationAttempt]);

  const addFavorite = useCallback(async (p) => {
    const ex = await window.api.exists(p);
    if (!mountedRef.current || !ex.exists || !ex.isDir) return;
    setFavorites((prev) => {
      if (prev.some((f) => f.path === p)) return prev;
      return [...prev, { icon: '📁', name: basename(p), path: p }];
    });
  }, []);

  const removeFavorite = useCallback((p) => {
    setFavorites((prev) => prev.filter((f) => f.path !== p));
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const registerNavigator = useCallback((paneId, fn) => {
    if (fn) navigators.current[paneId] = fn;
    else delete navigators.current[paneId];
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

  if (!special) return (
    <div className="app loading-app">
      {initializationError ? <>
        <span role="alert">설정을 불러오지 못했습니다: {initializationError}</span>
        <button className="tb-btn" onClick={() => setInitializationAttempt((value) => value + 1)}>다시 시도</button>
      </> : '불러오는 중…'}
    </div>
  );

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

      {settings.error && (
        <div className="settings-status" role="alert">
          <span>설정을 저장하지 못했습니다: {settings.error}</span>
          <button className="tb-btn" disabled={settings.saving} onClick={settings.retry}>
            {settings.saving ? '저장 중…' : '다시 시도'}
          </button>
        </div>
      )}

      <div className="body">
        <Sidebar
          special={special}
          onNavigate={sidebarNavigate}
          currentPath={panePaths[activePaneId]}
          favorites={favorites}
          onAddFavorite={addFavorite}
          onRemoveFavorite={removeFavorite}
        />
        {tabs.map((tab) => (
          <div key={tab.id} className={`panes ${tab.dual ? 'dual' : ''}`} hidden={tab.id !== activeTabId}>
            {tab.panes.map((pane) => (
              <Pane
                key={pane.id}
                paneId={pane.id}
                initialPath={pane.initialPath}
                active={tab.id === activeTabId && pane.id === activePaneId}
                onActivate={() => setActivePaneId(pane.id)}
                clipboard={clipboard}
                setClipboard={setClipboard}
                startCopy={startCopy}
                showHidden={showHidden}
                registerNavigator={registerNavigator}
                onPathChange={onPathChange}
                onOpenInNewTab={addTab}
                special={special}
              />
            ))}
          </div>
        ))}
      </div>
      {copyJobs.length > 0 && (
        <div className="copy-jobs" aria-label="복사 작업">
          {copyJobs.map((job) => (
            <div className="copy-progress" key={job.jobId} data-job-id={job.jobId}>
              <span className="cp-info" title={job.destDir}>
                복사 중… {job.currentFile ? basename(job.currentFile) : '준비 중'}
                {job.destDir && ` → ${basename(job.destDir)}`}
                {job.total > 0 && ` (${formatSize(job.copied) || '0 B'} / ${formatSize(job.total)})`}
              </span>
              <div className="cp-bar">
                <div className="cp-fill" style={{ width: `${job.total ? Math.min(100, (job.copied / job.total) * 100) : 0}%` }} />
              </div>
              <button className="cp-cancel" disabled={job.canceling} onClick={() => cancelCopy(job.jobId)}>
                {job.canceling ? '취소 중…' : '취소'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
