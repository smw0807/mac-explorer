import React, { useEffect, useState } from 'react';
import { fileIcon } from '../util.js';

// 아이콘은 확장자 단위로 동일하므로 확장자별로 한 번만 가져온다.
// .app 번들과 폴더는 경로/고정 키로 구분. 값: dataUrl 문자열('' = 실패, 이모지 폴백) 또는 Promise.
const cache = new Map();

function iconKey(entry) {
  if (entry.isDir) return entry.name.endsWith('.app') ? entry.path : '__dir__';
  return entry.ext ? 'ext:' + entry.ext : '__file__';
}

export default function FileIcon({ entry, size = 16, className = 'fl-icon' }) {
  const key = iconKey(entry);
  const cached = cache.get(key);
  const [url, setUrl] = useState(typeof cached === 'string' ? cached : '');

  useEffect(() => {
    let alive = true;
    const c = cache.get(key);
    if (typeof c === 'string') { setUrl(c); return; }
    const promise = c || window.api.fileIcon(entry.path).then((r) => {
      const u = r.ok ? r.dataUrl : '';
      cache.set(key, u);
      return u;
    });
    cache.set(key, promise);
    promise.then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [key, entry.path]);

  if (!url) {
    return <span className={className} style={{ fontSize: size * 0.85, lineHeight: 1 }}>{fileIcon(entry)}</span>;
  }
  return <img className={className} src={url} width={size} height={size} alt="" draggable={false} />;
}
