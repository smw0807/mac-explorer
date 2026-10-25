// Serialize settings writes and retain the newest complete snapshot until it is acknowledged.
export function createSettingsSaveQueue({ save, onChange = () => {}, delay = 500 }) {
  let latest = null;
  let latestJSON = null;
  let revision = 0;
  let savedRevision = 0;
  let timer = null;
  let inFlight = null;
  let error = null;
  let disposed = false;

  const getState = () => ({ dirty: revision > savedRevision, saving: !!inFlight, error });
  const notify = () => { if (!disposed) onChange(getState()); };
  const clearTimer = () => { clearTimeout(timer); timer = null; };

  async function drain() {
    while (!disposed && savedRevision < revision) {
      const writingRevision = revision;
      const snapshot = latest;
      let result;
      try {
        result = await save(snapshot);
      } catch (failure) {
        result = { ok: false, error: failure.message || String(failure) };
      }
      if (disposed) return { ok: false, error: '설정 저장이 중단되었습니다.' };
      if (!result?.ok) {
        error = result?.error || '설정을 저장할 수 없습니다.';
        notify();
        return { ok: false, error };
      }
      savedRevision = writingRevision;
      error = null;
      notify();
    }
    return { ok: !disposed };
  }

  function flush() {
    clearTimer();
    if (disposed) return Promise.resolve({ ok: false, error: '설정 저장이 중단되었습니다.' });
    if (inFlight) return inFlight;
    if (savedRevision === revision) return Promise.resolve({ ok: true });
    const pending = Promise.resolve().then(drain).then((result) => {
      if (inFlight === pending) inFlight = null;
      // A snapshot can arrive after drain's last iteration but before this microtask.
      // Keep callers awaiting that snapshot too; failed writes wait for an explicit retry.
      if (result.ok && !disposed && savedRevision < revision) return flush();
      notify();
      return result;
    });
    inFlight = pending;
    notify();
    return inFlight;
  }

  function enqueue(snapshot) {
    if (disposed) return;
    const json = JSON.stringify(snapshot);
    if (json === latestJSON) return;
    latestJSON = json;
    latest = JSON.parse(json);
    revision += 1;
    clearTimer();
    if (!inFlight) timer = setTimeout(flush, delay);
    notify();
  }

  function dispose() {
    disposed = true;
    clearTimer();
  }

  return { enqueue, flush, getState, dispose };
}
