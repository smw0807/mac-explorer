import { useCallback, useEffect, useRef, useState } from 'react';
import { createSettingsSaveQueue } from '../settingsSaveQueue.js';

export default function useSettingsPersistence(snapshot) {
  const [state, setState] = useState({ dirty: false, saving: false, error: null });
  const [readyError, setReadyError] = useState(null);
  const latestSnapshot = useRef(snapshot);
  const queueRef = useRef(null);
  const readyAcknowledged = useRef(false);
  const readyPromise = useRef(null);
  latestSnapshot.current = snapshot;
  const ready = snapshot != null;

  const flush = useCallback(async () => {
    const queue = queueRef.current;
    if (!queue || !latestSnapshot.current) return { ok: false, error: '설정을 불러오는 중입니다.' };
    // The close request can arrive before the ordinary debounced save effect.
    queue.enqueue(latestSnapshot.current);
    return queue.flush();
  }, []);

  const announceReady = useCallback(() => {
    if (readyAcknowledged.current) return Promise.resolve({ ok: true });
    if (readyPromise.current) return readyPromise.current;
    const queue = queueRef.current;
    if (!queue || !latestSnapshot.current) return Promise.resolve({ ok: false });
    const pending = Promise.resolve().then(() => {
      if (queueRef.current !== queue) return { ok: false };
      return window.api.settingsReady();
    }).then((result) => {
      if (queueRef.current !== queue) return { ok: false };
      if (!result?.ok) throw new Error(result?.error || '종료 전 설정 저장을 준비할 수 없습니다.');
      if (queueRef.current === queue) {
        readyAcknowledged.current = true;
        setReadyError(null);
      }
      return { ok: true };
    }).catch((error) => {
      const message = error.message || String(error);
      if (queueRef.current === queue) setReadyError(message);
      return { ok: false, error: message };
    }).finally(() => {
      if (readyPromise.current === pending) readyPromise.current = null;
    });
    readyPromise.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    const queue = createSettingsSaveQueue({ save: (value) => window.api.settingsSet(value), onChange: setState });
    queueRef.current = queue;
    readyAcknowledged.current = false;
    const off = window.api.onSettingsFlush(flush);
    return () => {
      off();
      queue.dispose();
      if (queueRef.current === queue) queueRef.current = null;
      readyPromise.current = null;
    };
  }, [flush]);

  useEffect(() => {
    if (snapshot) queueRef.current?.enqueue(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (ready) announceReady();
  }, [ready, announceReady]);

  const retry = useCallback(async () => {
    const readiness = await announceReady();
    if (!readiness.ok) return readiness;
    return flush();
  }, [announceReady, flush]);

  return { ...state, error: readyError || state.error, retry, flush };
}
