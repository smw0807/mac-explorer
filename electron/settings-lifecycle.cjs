const { randomUUID } = require('crypto');

function createSettingsLifecycle({ getWindows, isQuitting, onError, timeoutMs = 5000 }) {
  const states = new Map();

  function errorFor(state, message) {
    return Object.assign(new Error(message), { window: state.win });
  }

  function restoreInput(state) {
    if (state.originalEnabled === undefined) return;
    if (!state.win.isDestroyed()) state.win.setEnabled(state.originalEnabled);
    state.originalEnabled = undefined;
  }

  function freezeInput(state) {
    if (state.originalEnabled !== undefined) return;
    state.originalEnabled = state.win.isEnabled();
    state.win.setEnabled(false);
  }

  function finish(state, pending, error) {
    if (state.pending !== pending) return;
    state.pending = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve({ version: pending.version, frame: pending.frame });
  }

  function sendRequest(state) {
    const pending = state.pending;
    if (!pending || pending.sent || !state.ready) return;
    pending.sent = true;
    pending.version = state.version;
    pending.frame = state.frame;
    try {
      state.wc.send('settings:flush', { requestId: pending.id, reason: pending.reason });
    } catch (error) { finish(state, pending, error); }
  }

  function requestFlush(state, reason) {
    if (state.pending) return state.pending.promise;
    if (state.win.isDestroyed() || state.wc.isDestroyed()) {
      return Promise.reject(errorFor(state, '설정을 저장할 화면이 닫혔습니다.'));
    }
    const pending = { id: randomUUID(), reason, sent: false };
    pending.promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
    state.pending = pending;
    // Readiness and the save acknowledgment share one deadline.
    pending.timer = setTimeout(() => finish(state, pending,
      errorFor(state, '설정 저장 응답을 5초 안에 받지 못했습니다.')), timeoutMs);
    sendRequest(state);
    return pending.promise;
  }

  function invalidateDocument(state, message, alwaysReject = false) {
    state.version++;
    state.ready = false;
    state.frame = null;
    // An initial navigation may begin after a close request but before hydration.
    if (state.pending && (state.pending.sent || alwaysReject)) {
      finish(state, state.pending, errorFor(state, message));
    }
  }

  function assertSavedDocument(state, saved) {
    if (state.win.isDestroyed() || !state.ready || saved.version !== state.version
      || saved.frame !== state.frame) throw errorFor(state, '설정 저장 중 화면이 변경되었습니다.');
  }

  function register(win) {
    const wc = win.webContents;
    const state = { win, wc, ready: false, frame: null, version: 0,
      pending: null, closeAttempt: null, localFailure: null, allowClose: false, originalEnabled: undefined };
    states.set(wc.id, state);

    win.on('close', (event) => {
      if (state.allowClose) return;
      event.preventDefault();
      if (isQuitting() || state.closeAttempt) return;
      freezeInput(state);
      const attempt = {};
      state.closeAttempt = attempt;
      attempt.promise = (async () => {
        const saved = await requestFlush(state, 'close');
        if (state.closeAttempt !== attempt || isQuitting()) return;
        assertSavedDocument(state, saved);
        state.allowClose = true;
        win.close();
      })().catch((error) => {
        if (state.closeAttempt !== attempt) return;
        if (isQuitting()) {
          state.localFailure = error;
          return;
        }
        state.allowClose = false;
        restoreInput(state);
        // Error UI may immediately trigger another close. Release this attempt
        // before notifying it; the identity guard in finally preserves a retry.
        state.closeAttempt = null;
        onError(error);
      }).finally(() => {
        if (state.closeAttempt === attempt) state.closeAttempt = null;
      });
    });
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      // Electron supports the legacy positional fields alongside event properties.
      const mainFrame = _event.isMainFrame ?? isMainFrame;
      const sameDocument = _event.isSameDocument ?? isInPlace;
      if (mainFrame && !sameDocument) invalidateDocument(state, '설정 저장 중 화면이 다시 로드되었습니다.');
    });
    wc.on('render-process-gone', () => invalidateDocument(state, '설정을 저장할 화면의 실행이 중단되었습니다.', true));
    wc.on('destroyed', () => invalidateDocument(state, '설정을 저장할 화면이 닫혔습니다.', true));
    win.on('closed', () => {
      invalidateDocument(state, '설정을 저장할 창이 닫혔습니다.', true);
      state.closeAttempt = null;
      states.delete(wc.id);
    });
    return state;
  }

  function stateFor(event) {
    const state = states.get(event.sender.id);
    if (!state || state.wc !== event.sender || state.win.isDestroyed()) throw new Error('설정 저장 대상 창을 찾을 수 없습니다.');
    return state;
  }

  function setReady(event, ready) {
    const state = stateFor(event);
    if (!ready) invalidateDocument(state, '설정 저장 처리가 해제되었습니다.', true);
    else {
      state.ready = true;
      state.frame = event.senderFrame;
      sendRequest(state);
    }
  }

  function acknowledge(event, requestId, result) {
    const state = stateFor(event);
    const pending = state.pending;
    if (!pending || !pending.sent || pending.id !== requestId || pending.version !== state.version
      || pending.frame !== event.senderFrame || state.frame !== event.senderFrame) return false;
    finish(state, pending, result.ok ? null : errorFor(state, result.error || '설정을 저장하지 못했습니다.'));
    return true;
  }

  async function prepareToQuit() {
    const current = getWindows().filter((win) => !win.isDestroyed()).map((win) => {
      const state = states.get(win.webContents.id);
      if (!state) throw new Error('설정 저장 대상 창이 준비되지 않았습니다.');
      freezeInput(state);
      return state;
    });
    // A close started before quit must never remove one window while others fail.
    await Promise.all(current.map((state) => state.closeAttempt?.promise));
    for (const state of current) if (state.localFailure) throw state.localFailure;
    // Always issue fresh requests after file operations drain, even if a local
    // close has already acknowledged an earlier snapshot.
    const saved = await Promise.all(current.map((state) => requestFlush(state, 'quit')));
    current.forEach((state, index) => assertSavedDocument(state, saved[index]));
    for (const state of current) state.allowClose = true;
  }

  function cancelQuit(error) {
    for (const state of states.values()) {
      state.closeAttempt = null;
      state.localFailure = null;
      state.allowClose = false;
      if (state.pending) finish(state, state.pending, error || errorFor(state, '앱 종료가 취소되었습니다.'));
      restoreInput(state);
    }
  }

  return { register, setReady, acknowledge, prepareToQuit, cancelQuit };
}

module.exports = { createSettingsLifecycle };
