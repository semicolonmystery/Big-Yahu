import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stateFile = path.join(root, 'output', 'playwright', 'server-state.json');
const prefix = 'big-yahu-e2e-';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkedTempDirectory(directory) {
  const absolute = path.resolve(directory);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith(prefix)) {
    throw new Error(`Refusing to clean a directory outside the E2E temp area: ${absolute}`);
  }
  return absolute;
}

/**
 * Playwright global teardown asks the wrapper to stop before its process-tree
 * cleanup. This marker also works on Windows, where SIGTERM cannot be handled
 * gracefully by a webServer wrapper. No test-only endpoints enter the app.
 */
export default async function stopE2EServer() {
  if (!fs.existsSync(stateFile)) return;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const directory = checkedTempDirectory(state.directory);
  fs.writeFileSync(path.join(directory, 'shutdown'), 'stop');
  const deadline = Date.now() + 10_000;
  while (fs.existsSync(stateFile) && Date.now() < deadline) await delay(100);
  if (fs.existsSync(stateFile)) throw new Error(`E2E server did not finish cleanup: ${stateFile}`);
}

async function startE2EServer() {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    throw new Error('Build the admin panel with npm run build before running browser tests.');
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  if (fs.existsSync(stateFile)) throw new Error(`An E2E server state already exists; inspect it before starting another run: ${stateFile}`);
  const directory = checkedTempDirectory(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  let child;
  let watcher;
  let killTimer;
  let requestedStop = false;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        // Empty values intentionally block dotenv from filling live secrets.
        DISCORD_TOKEN: '', DISCORD_GUILD_ID: '', GEMINI_API_KEY: '', PLUGIN_ENV_KEY: '',
        SQLITE_PATH: path.join(directory, 'e2e.sqlite3'),
        NODE_ENV: 'production', PORT: '3137', TRUSTED_PROXY_HOPS: '0',
        // The browser tests probe this separate local endpoint and fixture the
        // Chroma-backed screens only when it is unavailable. Never use .env's DB.
        CHROMA_HOST: '127.0.0.1', CHROMA_PORT: '3138',
      },
    });
    const exited = new Promise((resolve, reject) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', reject);
    });
    fs.writeFileSync(stateFile, JSON.stringify({ directory, wrapperPid: process.pid, childPid: child.pid }), { flag: 'wx' });
    const stop = () => {
      if (requestedStop) return;
      requestedStop = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
        killTimer.unref();
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    watcher = setInterval(() => {
      if (fs.existsSync(path.join(directory, 'shutdown'))) stop();
    }, 100);
    const code = await exited;
    if (!requestedStop) process.exitCode = code || 1;
  } finally {
    clearInterval(watcher);
    clearTimeout(killTimer);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(checkedTempDirectory(directory), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.directory === directory) fs.rmSync(stateFile);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startE2EServer().catch((error) => {
    console.error('[e2e-server]', error);
    process.exitCode = 1;
  });
}
