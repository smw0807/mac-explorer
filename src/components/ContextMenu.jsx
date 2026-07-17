import React, { useEffect, useRef } from 'react';

export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('mousedown', handleOutside, true);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', handleKey, true);
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
    }
    return () => {
      window.removeEventListener('mousedown', handleOutside, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  // keep menu inside viewport
  const style = { left: x, top: y };
  const menuH = items.length * 26 + 12;
  if (typeof window !== 'undefined') {
    if (y + menuH > window.innerHeight) style.top = Math.max(8, window.innerHeight - menuH - 8);
    if (x + 220 > window.innerWidth) style.left = Math.max(8, window.innerWidth - 228);
  }

  return (
    <div className="context-menu" style={style} ref={ref}>
      {items.map((item, i) =>
        item.separator ? (
          <div className="cm-sep" key={i} />
        ) : (
          <button
            key={i}
            className="cm-item"
            disabled={item.disabled}
            onClick={() => { onClose(); item.onClick?.(); }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="cm-shortcut">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>
  );
}
