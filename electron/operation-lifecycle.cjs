function createOperationLifecycle(app, {
  cancelOperations = () => {},
  prepareToQuit = () => {},
  onError = (error) => console.error('앱 종료 준비에 실패했습니다.', error),
} = {}) {
  const pending = new Set();
  let shuttingDown = false;
  let quitAllowed = false;

  // Register before invoking the callback, including callbacks that return a
  // synchronous job ID while starting another, separately tracked operation.
  function run(callback) {
    if (shuttingDown) throw new Error('앱을 종료하는 중입니다. 새 파일 작업을 시작할 수 없습니다.');
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    pending.add(completion);
    const finish = () => {
      pending.delete(completion);
      resolveCompletion();
    };
    try {
      const result = callback();
      if (result && typeof result.then === 'function') Promise.resolve(result).then(finish, finish);
      else finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  }

  app.on('before-quit', (event) => {
    if (quitAllowed) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;

    void (async () => {
      cancelOperations();
      // Future renderer/session flushes can run here while windows still exist.
      await prepareToQuit();
      while (pending.size) await Promise.all([...pending]);
      quitAllowed = true;
      app.quit();
    })().catch((error) => {
      // A failed preparation must keep the app usable rather than lose state.
      shuttingDown = false;
      quitAllowed = false;
      onError(error);
    });
  });

  return { run, isShuttingDown: () => shuttingDown };
}

module.exports = { createOperationLifecycle };
