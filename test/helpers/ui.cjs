const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');

// Install the DOM before loading React DOM so its input event support is detected.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.alert = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const projectRoot = path.resolve(__dirname, '../..');

function loadComponent(relativePath) {
  const filename = path.join(projectRoot, relativePath);
  const result = buildSync({
    entryPoints: [filename],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['react', 'react-dom', 'react-dom/*'],
  });
  // Each mount gets fresh module state, including the application's undo history.
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(result.outputFiles[0].text, filename);
  return compiled.exports.default;
}

function file(name, options = {}) {
  return {
    name,
    path: `/test/${name}`,
    isDir: false,
    hidden: name.startsWith('.'),
    size: 1,
    mtime: 0,
    ext: name.split('.').at(-1),
    ...options,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(action = () => {}) {
  await act(async () => {
    await action();
    await new Promise(setImmediate);
  });
}

async function mountComponent(relativePath, { props = {}, api = {} } = {}) {
  const listeners = { directory: new Set(), copy: new Set() };
  const alerts = [];
  const previousAlert = globalThis.alert;
  globalThis.alert = (message) => alerts.push(message);
  const subscribe = (set) => (callback) => {
    set.add(callback);
    return () => set.delete(callback);
  };
  window.api = {
    readDir: async () => ({ ok: true, entries: [] }),
    statfs: async () => ({ ok: true, free: 1024 }),
    watchDir: async () => ({ ok: true }),
    unwatchDir: async () => ({ ok: true }),
    onDirChanged: subscribe(listeners.directory),
    onCopyProgress: subscribe(listeners.copy),
    fileIcon: async () => ({ ok: false }),
    ...api,
  };
  const Component = loadComponent(relativePath);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let currentProps = props;
  let mounted = true;
  await flush(() => root.render(React.createElement(Component, currentProps)));

  return {
    container,
    alerts,
    api: window.api,
    query: (selector) => container.querySelector(selector),
    queryAll: (selector) => [...container.querySelectorAll(selector)],
    async update(nextProps) {
      currentProps = { ...currentProps, ...nextProps };
      await flush(() => root.render(React.createElement(Component, currentProps)));
    },
    async emitDirectory(payload) {
      await flush(() => { for (const listener of listeners.directory) listener(payload); });
    },
    async emitCopy(payload) {
      await flush(() => { for (const listener of listeners.copy) listener(payload); });
    },
    async unmount() {
      if (!mounted) return;
      mounted = false;
      await flush(() => root.unmount());
      container.remove();
      globalThis.alert = previousAlert;
    },
  };
}

async function mountPane({ entries = [], props = {}, api = {} } = {}) {
  return mountComponent('src/components/Pane.jsx', {
    props: {
      paneId: 'test-pane',
      initialPath: '/test',
      active: true,
      onActivate() {},
      clipboard: null,
      setClipboard() {},
      showHidden: false,
      registerNavigator() {},
      onPathChange() {},
      onOpenInNewTab() {},
      special: { home: '/test' },
      ...props,
    },
    api: { readDir: async () => ({ ok: true, entries }), ...api },
  });
}

async function mountApp({ entries = [], api = {} } = {}) {
  return mountComponent('src/App.jsx', {
    api: {
      specialDirs: async () => ({
        home: '/test', desktop: '/test/Desktop', documents: '/test/Documents',
        downloads: '/test/Downloads', pictures: '/test/Pictures', applications: '/Applications', volumes: [],
      }),
      settingsGet: async () => ({ settings: {} }),
      settingsSet: async () => ({ ok: true }),
      exists: async () => ({ exists: true, isDir: true }),
      conflicts: async () => ({ ok: true, names: [] }),
      readDir: async () => ({ ok: true, entries }),
      ...api,
    },
  });
}

async function click(element, options = {}) {
  await flush(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, ...options })));
}

async function key(element, value, options = {}) {
  await flush(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })));
}

async function changeValue(element, value) {
  await flush(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

module.exports = { mountComponent, mountPane, mountApp, file, deferred, flush, click, key, changeValue };
