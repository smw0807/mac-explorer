const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const run = promisify(execFile);

async function main() {
  if (process.platform !== 'darwin') throw new Error('실제 앱 검증은 macOS에서 실행해주세요.');
  const project = path.resolve(__dirname, '..');
  await fs.access(path.join(project, 'dist/index.html'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV;
  // Electron 42+ downloads its platform binary on the first CLI invocation.
  const cli = require.resolve('electron/cli.js');
  const version = await run(process.execPath, [cli, '--version'], { env, timeout: 180000 });
  process.stdout.write(version.stdout);
  for (const mode of ['smoke', 'move', 'copy']) {
    const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-smoke-')));
    try {
      const script = mode === 'smoke' ? 'electron-smoke.cjs' : 'electron-lifecycle.cjs';
      const result = await run(process.execPath, [cli, path.join(project, 'test', script)], {
        cwd: project,
        env: { ...env, MAC_EXPLORER_SMOKE_ROOT: fixture, MAC_EXPLORER_LIFECYCLE_MODE: mode },
        timeout: 30000, maxBuffer: 2 * 1024 * 1024,
      });
      process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error.stderr || error.message);
  process.exitCode = 1;
});
