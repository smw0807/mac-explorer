import { useState, useMemo, useRef, useEffect } from 'react';

// 다중 선택 항목의 일괄 이름 변경 모달.
// replace: 찾기/바꾸기, sequence: 패턴(#은 연번, 개수만큼 0 채움) + 시작 번호, 확장자 유지
export default function BatchRenameDialog({ entries, onCancel, onApply }) {
  const [mode, setMode] = useState('replace');
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [pattern, setPattern] = useState('이름-###');
  const [start, setStart] = useState(1);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const composingRef = useRef(false);
  const mountedRef = useRef(true);
  const formRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const proposed = useMemo(() => entries.map((en, i) => {
    if (mode === 'replace') {
      if (!find) return en.name;
      return en.name.split(find).join(replace);
    }
    const dot = en.name.lastIndexOf('.');
    const ext = !en.isDir && dot > 0 ? en.name.slice(dot) : '';
    const num = String((Number(start) || 0) + i);
    return pattern.replace(/#+/g, (m) => num.padStart(m.length, '0')) + ext;
  }), [entries, mode, find, replace, pattern, start]);

  const changed = proposed.some((n, i) => n && n !== entries[i].name);

  const cancel = () => {
    if (!busyRef.current) onCancel();
  };

  const apply = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busyRef.current || composingRef.current || !changed) return;
    busyRef.current = true;
    setBusy(true);
    formRef.current?.focus();
    try {
      await onApply(entries.map((en, i) => ({ from: en.path, to: proposed[i] })).filter((r) => r.to));
    } catch (error) {
      if (mountedRef.current) alert(error.message || String(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const onFieldKey = (e) => {
    e.stopPropagation();
    const composing = composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229;
    if (e.key === 'Enter' && (composing || busyRef.current)) e.preventDefault();
    if (e.key === 'Escape' && !composing) { e.preventDefault(); cancel(); }
    if (e.key === 'Tab') {
      const controls = [...e.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { e.preventDefault(); formRef.current?.focus(); }
      else if (e.target === formRef.current || (e.shiftKey ? e.target === first : e.target === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <form className="modal" ref={formRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="일괄 이름 변경" aria-busy={busy}
        onSubmit={apply} onKeyDown={onFieldKey}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}>
        <div className="modal-title">일괄 이름 변경 — {entries.length}개 항목</div>
        <div className="modal-modes">
          <button type="button" disabled={busy} className={`tb-btn ${mode === 'replace' ? 'on' : ''}`} onClick={() => setMode('replace')}>찾기/바꾸기</button>
          <button type="button" disabled={busy} className={`tb-btn ${mode === 'sequence' ? 'on' : ''}`} onClick={() => setMode('sequence')}>연번 이름</button>
        </div>
        {mode === 'replace' ? (
          <div className="modal-fields">
            <label>찾기 <input autoFocus disabled={busy} value={find} onChange={(e) => setFind(e.target.value)} /></label>
            <label>바꾸기 <input disabled={busy} value={replace} onChange={(e) => setReplace(e.target.value)} /></label>
          </div>
        ) : (
          <div className="modal-fields">
            <label>패턴 <input autoFocus disabled={busy} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="예: 휴가-###" /></label>
            <label>시작 번호 <input type="number" disabled={busy} value={start} onChange={(e) => setStart(e.target.value)} /></label>
          </div>
        )}
        <div className="modal-preview">
          {entries.slice(0, 6).map((en, i) => (
            <div key={en.path} className="mp-row">
              <span className="mp-old" title={en.name}>{en.name}</span>
              <span className="mp-arrow">→</span>
              <span className={`mp-new ${proposed[i] !== en.name ? 'diff' : ''}`} title={proposed[i]}>{proposed[i]}</span>
            </div>
          ))}
          {entries.length > 6 && <div className="mp-more">… 외 {entries.length - 6}개</div>}
        </div>
        <div className="modal-actions">
          <button type="button" className="tb-btn" disabled={busy} onClick={cancel}>취소</button>
          <button type="submit" className="tb-btn primary" disabled={!changed || busy}>{busy ? '변경 중…' : '적용'}</button>
        </div>
      </form>
    </div>
  );
}
