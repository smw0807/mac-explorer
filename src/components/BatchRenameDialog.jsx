import React, { useState, useMemo } from 'react';

// 다중 선택 항목의 일괄 이름 변경 모달.
// replace: 찾기/바꾸기, sequence: 패턴(#은 연번, 개수만큼 0 채움) + 시작 번호, 확장자 유지
export default function BatchRenameDialog({ entries, onCancel, onApply }) {
  const [mode, setMode] = useState('replace');
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [pattern, setPattern] = useState('이름-###');
  const [start, setStart] = useState(1);

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

  const apply = () => {
    onApply(entries.map((en, i) => ({ from: en.path, to: proposed[i] })).filter((r) => r.to));
  };

  const onFieldKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && changed) apply();
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" onKeyDown={onFieldKey}>
        <div className="modal-title">일괄 이름 변경 — {entries.length}개 항목</div>
        <div className="modal-modes">
          <button className={`tb-btn ${mode === 'replace' ? 'on' : ''}`} onClick={() => setMode('replace')}>찾기/바꾸기</button>
          <button className={`tb-btn ${mode === 'sequence' ? 'on' : ''}`} onClick={() => setMode('sequence')}>연번 이름</button>
        </div>
        {mode === 'replace' ? (
          <div className="modal-fields">
            <label>찾기 <input autoFocus value={find} onChange={(e) => setFind(e.target.value)} /></label>
            <label>바꾸기 <input value={replace} onChange={(e) => setReplace(e.target.value)} /></label>
          </div>
        ) : (
          <div className="modal-fields">
            <label>패턴 <input autoFocus value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="예: 휴가-###" /></label>
            <label>시작 번호 <input type="number" value={start} onChange={(e) => setStart(e.target.value)} /></label>
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
          <button className="tb-btn" onClick={onCancel}>취소</button>
          <button className="tb-btn primary" disabled={!changed} onClick={apply}>적용</button>
        </div>
      </div>
    </div>
  );
}
