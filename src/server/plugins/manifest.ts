import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLUGIN_API_VERSION } from '@big-yahu/plugin-sdk';
import type { PluginManifest } from '@big-yahu/plugin-sdk';
import { env } from '../env';

/** Plugins live beside the database, not in the source tree, so they survive a rebuild. */
export const PLUGINS_DIR = path.resolve(path.dirname(path.resolve(env.sqlitePath)), 'plugins');

/**
 * Resolved from this module, not from `process.cwd()`. Both of these used to be
 * cwd-relative, so starting the bot from anywhere but the project root pointed
 * them at directories that do not exist — and `linkNodeModules` below fails
 * *silently* in that case, after which every plugin importing a shared library
 * dies with no explanation.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the plugins that ship with the bot live: this directory's `bundled/`. */
export const BUNDLED_DIR = path.join(HERE, 'bundled');

/** The bot's own node_modules — three levels up from `src/server/plugins`. */
const BOT_NODE_MODULES = path.resolve(HERE, '..', '..', '..', 'node_modules');

/**
 * The contract version and the manifest shape live in the plugin SDK, so a
 * plugin author imports the same number the bot checks against rather than
 * copying it. Everything else in this file resolves host paths and stays here.
 */
export { PLUGIN_API_VERSION } from '@big-yahu/plugin-sdk';
export type { PluginManifest } from '@big-yahu/plugin-sdk';


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
  const { apiVersion, apiVersionSource, apiVersionConflict } = readApiVersion(parsed, overrides);

  return {
    id,
    name: pick('displayName') ?? pick('name') ?? id,
    description: pick('description') ?? '',
    version: pick('version') ?? '0.0.0',
    main,
    apiVersion,
    apiVersionSource,
    apiVersionConflict,
  };
}

const SDK_PACKAGE = '@big-yahu/plugin-sdk';

/** The leading integer of a semver range: `^2.1.0`, `>=2 <3` and `2.x` all give 2. */
function majorOf(range: string): number | null {
  const match = /^\D*(\d+)/.exec(range.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Which contract version a plugin was written against.
 *
 * Taken from the SDK it depends on, because that is a thing the author already
 * maintains: the package's major version *is* the contract version, so
 * `npm update` is the whole of keeping the declaration current. A separate
 * `apiVersion` field was a second copy of the same fact, and a second copy of a
 * fact is a thing that drifts — which is the problem the SDK exists to solve.
 *
 * Read out of package.json rather than from the plugin's own imports, since the
 * check has to happen before the entry file is imported at all.
 *
 * The explicit field survives as the escape hatch for a plugin that does not
 * depend on the SDK — plain JavaScript, no build step, nothing to typecheck.
 * When both are present and disagree, that is refused rather than resolved:
 * silently preferring one would hide exactly the drift being prevented.
 */
function readApiVersion(
  parsed: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Pick<PluginManifest, 'apiVersion' | 'apiVersionSource' | 'apiVersionConflict'> {
  const ranges = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .map((section) => (parsed[section] as Record<string, unknown> | undefined)?.[SDK_PACKAGE])
    .find((range): range is string => typeof range === 'string' && range.trim().length > 0);
  const fromSdk = ranges ? majorOf(ranges) : null;

  const declared = overrides.apiVersion;
  const fromField =
    typeof declared === 'number' && Number.isInteger(declared)
      ? declared
      : typeof declared === 'string' && /^\d+$/.test(declared.trim())
        ? Number.parseInt(declared.trim(), 10)
        : null;

  if (fromSdk !== null && fromField !== null && fromSdk !== fromField) {
    return {
      apiVersion: fromSdk,
      apiVersionSource: 'sdk-dependency',
      apiVersionConflict:
        `It depends on ${SDK_PACKAGE} "${ranges}" but also sets "bigYahu": { "apiVersion": ${fromField} }. `
        + 'Those disagree — drop the apiVersion field and let the dependency say it.',
    };
  }

  if (fromSdk !== null) return { apiVersion: fromSdk, apiVersionSource: 'sdk-dependency', apiVersionConflict: null };
  if (fromField !== null) return { apiVersion: fromField, apiVersionSource: 'manifest-field', apiVersionConflict: null };

  // Depending on the SDK by git URL or tag says nothing about which contract it
  // is, so telling the author to depend on it would read as nonsense.
  if (ranges) {
    return {
      apiVersion: null,
      apiVersionSource: null,
      apiVersionConflict:
        `It depends on ${SDK_PACKAGE} "${ranges}", which carries no version number, so there is nothing to `
        + `check against. Use a version range like "^${PLUGIN_API_VERSION}", or set "bigYahu": `
        + `{ "apiVersion": ${PLUGIN_API_VERSION} } alongside it.`,
    };
  }

  return { apiVersion: null, apiVersionSource: null, apiVersionConflict: null };
}

/** Why a plugin will not run, or null when it will. */
export function incompatibilityReason(manifest: PluginManifest): string | null {
  if (manifest.apiVersionConflict) return manifest.apiVersionConflict;

  if (manifest.apiVersion === null) {
    return `Declares no plugin API version. Depend on ${SDK_PACKAGE} — its major version is the contract `
      + `version — or, without it, set "bigYahu": { "apiVersion": ${PLUGIN_API_VERSION} } in package.json.`;
  }

  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    const fix =
      manifest.apiVersionSource === 'sdk-dependency'
        ? `Update it to ${SDK_PACKAGE}@^${PLUGIN_API_VERSION}.`
        : `Set "bigYahu": { "apiVersion": ${PLUGIN_API_VERSION} }, or depend on ${SDK_PACKAGE}@^${PLUGIN_API_VERSION} instead.`;
    return `Built for plugin API v${manifest.apiVersion}; this bot runs v${PLUGIN_API_VERSION}. ${fix}`;
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
  const target = BOT_NODE_MODULES;
  const link = path.join(PLUGINS_DIR, 'node_modules');
  if (!fs.existsSync(target)) {
    console.warn(`[plugins] no node_modules at ${target}; plugins cannot import the bot's libraries`);
    return;
  }

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
