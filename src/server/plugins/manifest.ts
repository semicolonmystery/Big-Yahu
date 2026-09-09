import path from 'node:path';
import fs from 'node:fs';
import { env } from '../env';

/** Plugins live beside the database, not in the source tree, so they survive a rebuild. */
export const PLUGINS_DIR = path.resolve(path.dirname(path.resolve(env.sqlitePath)), 'plugins');

/** Kept for the plugin that ships with the bot. */
export const BUNDLED_DIR = path.resolve('src/server/plugins/bundled');

/**
 * The plugin contract's own version, bumped whenever anything a plugin depends
 * on changes shape — a hook's arguments, what a tool handler is handed, what a
 * page must return. A plugin declares the version it was written against and
 * must match exactly.
 *
 * Exact, not "same major", because the failure being prevented is a plugin
 * running against a contract it does not understand, and a partial match is
 * precisely the fuzzy version of that. A mismatch loads the plugin as
 * incompatible rather than crashing the bot: it is listed in the panel with the
 * reason, and none of its hooks, tools or pages are reachable.
 */
export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  /** Entry file relative to the plugin directory. */
  main: string;
  /** The contract version this plugin declares, or null when it declares none. */
  apiVersion: number | null;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function isValidPluginId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/**
 * A plugin is an ordinary Node package: a package.json plus an entry file whose
 * default export is the plugin. `bigYahu` overrides let a package describe
 * itself without disturbing its npm identity.
 */
export function readManifest(directory: string): PluginManifest {
  const packagePath = path.join(directory, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new Error('package.json is missing — a plugin must be a Node package');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('package.json is not valid JSON');
  }

  const overrides = (parsed.bigYahu ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = overrides[key] ?? parsed[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };

  const rawId = pick('id') ?? pick('name');
  if (!rawId) throw new Error('package.json needs a "name"');
  const id = rawId.replace(/^@[^/]+\//, '').toLowerCase();
  if (!isValidPluginId(id)) {
    throw new Error(`"${id}" is not a usable plugin id — use lowercase letters, digits and dashes`);
  }

  const main = pick('main') ?? 'index.js';
  const entry = path.join(directory, main);
  if (!fs.existsSync(entry)) throw new Error(`entry file "${main}" does not exist in the package`);
  // The separator matters: without it "plugins/foo" is a prefix of
  // "plugins/foo-evil", so a plugin could point `main` at a sibling directory's
  // file and have that imported instead. Every other containment check in the
  // codebase includes it; this one did not.
  if (!path.resolve(entry).startsWith(path.resolve(directory) + path.sep)) {
    throw new Error(`entry file "${main}" points outside the package`);
  }

  // Read but never rejected here: a plugin declaring the wrong version is still
  // installed and still listed, it simply does not run. Refusing the install
  // outright would leave an operator with an error and nothing to look at.
  const declared = overrides.apiVersion;
  const apiVersion =
    typeof declared === 'number' && Number.isInteger(declared)
      ? declared
      : typeof declared === 'string' && /^\d+$/.test(declared.trim())
        ? Number.parseInt(declared.trim(), 10)
        : null;

  return {
    id,
    name: pick('displayName') ?? pick('name') ?? id,
    description: pick('description') ?? '',
    version: pick('version') ?? '0.0.0',
    main,
    apiVersion,
  };
}

/** Why a plugin will not run, or null when it will. */
export function incompatibilityReason(manifest: PluginManifest): string | null {
  if (manifest.apiVersion === null) {
    return `Declares no plugin API version. Add "bigYahu": { "apiVersion": ${PLUGIN_API_VERSION} } to its package.json.`;
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    return `Built for plugin API v${manifest.apiVersion}; this bot runs v${PLUGIN_API_VERSION}.`;
  }
  return null;
}

/**
 * Node resolves a plugin's bare imports by walking up from its own directory,
 * which only reaches the bot's node_modules when the data directory happens to
 * sit inside the project. Linking it here makes that work wherever the data
 * directory lives, so a plugin can `import { drizzle } from 'drizzle-orm/...'`
 * and use the same libraries the bot already ships.
 */
export function linkNodeModules(): void {
  const target = path.resolve('node_modules');
  const link = path.join(PLUGINS_DIR, 'node_modules');
  if (!fs.existsSync(target)) return;

  try {
    if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
      if (fs.realpathSync(link) === target) return;
      fs.rmSync(link, { recursive: true, force: true });
    }
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    fs.symlinkSync(target, link, 'dir');
  } catch (error) {
    console.warn(
      '[plugins] could not link node_modules into the plugin directory; plugins importing shared libraries may fail:',
      error instanceof Error ? error.message : error,
    );
  }
}
