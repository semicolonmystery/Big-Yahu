import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { PLUGINS_DIR, readManifest, type PluginManifest } from './manifest';

const run = promisify(execFile);
const CLONE_TIMEOUT_MS = 60_000;
const NPM_TIMEOUT_MS = 300_000;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'big-yahu-plugin-'));
}

/** A package.json anywhere but the root means the plugin sits in a subfolder. */
function findPackageRoot(directory: string): string {
  if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return directory;
}

function declaresDependencies(directory: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(parsed.dependencies ?? {}).length > 0;
  } catch {
    return false;
  }
}

/**
 * A plugin may depend on libraries the bot does not ship. Its own node_modules
 * is resolved before the shared one linked beside it, so it gets its versions
 * without disturbing the bot's.
 *
 * Lifecycle scripts are skipped: a plugin that has been installed but never
 * enabled should not have executed anything. Its own code still runs in this
 * process once enabled, so this bounds when that starts, not whether it can.
 */
async function installDependencies(directory: string): Promise<void> {
  if (!declaresDependencies(directory)) return;
  if (fs.existsSync(path.join(directory, 'node_modules'))) return;

  console.log(`[plugins] installing dependencies for ${path.basename(directory)}`);
  try {
    await run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: directory,
      timeout: NPM_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not install this plugin's dependencies: ${detail.split('\n').slice(-4).join(' ').slice(0, 400)}`);
  }
}

export interface InstallResult {
  manifest: PluginManifest;
  /** The id already existed, so this replaced its code and kept its data. */
  updated: boolean;
}

/**
 * Installing over an existing id is an update, not a clash.
 *
 * The directory holds only the plugin's code — its database lives beside the
 * bot's under `plugin-data/`, and its config, secrets and storage are rows in
 * the bot's own tables. So replacing the directory outright is the whole update:
 * nothing an operator configured or a plugin recorded is inside it. Uninstalling
 * is the thing that throws data away, and this is deliberately not that.
 */
function install(source: string): InstallResult {
  const root = findPackageRoot(source);
  const manifest = readManifest(root);
  const target = path.join(PLUGINS_DIR, manifest.id);

  const updated = fs.existsSync(target);
  if (updated) fs.rmSync(target, { recursive: true, force: true });

  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  fs.cpSync(root, target, { recursive: true });
  fs.rmSync(path.join(target, '.git'), { recursive: true, force: true });
  return { manifest, updated };
}

export async function installFromGit(url: string): Promise<InstallResult> {
  if (!/^https:\/\/[\w.-]+\/[\w./~-]+$/i.test(url)) {
    throw new Error('Only https git URLs are accepted');
  }
  const scratch = tempDir();
  try {
    await run('git', ['clone', '--depth', '1', '--single-branch', '--', url, scratch], {
      timeout: CLONE_TIMEOUT_MS,
      // Never let git stop for credentials on a private repo; fail instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    const result = install(scratch);
    await installDependencies(path.join(PLUGINS_DIR, result.manifest.id));
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail.includes('clone') ? `Could not clone ${url}` : detail);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function installFromZip(archive: Buffer): Promise<InstallResult> {
  const scratch = tempDir();
  try {
    for (const entry of new AdmZip(archive).getEntries()) {
      if (entry.isDirectory) continue;
      // Zip entries can carry ../ and absolute paths; both must not escape.
      const destination = path.join(scratch, entry.entryName);
      if (!path.resolve(destination).startsWith(path.resolve(scratch) + path.sep)) {
        throw new Error(`Archive entry "${entry.entryName}" escapes the plugin folder`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, entry.getData());
    }
    const result = install(scratch);
    await installDependencies(path.join(PLUGINS_DIR, result.manifest.id));
    return result;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function uninstall(id: string): boolean {
  const target = path.join(PLUGINS_DIR, id);
  if (!path.resolve(target).startsWith(path.resolve(PLUGINS_DIR) + path.sep)) return false;
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

export function uninstallAll(): string[] {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  const removed = fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    // node_modules is the linked shared library folder, not a plugin.
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'node_modules')
    .map((entry) => entry.name);
  for (const id of removed) uninstall(id);
  return removed;
}
