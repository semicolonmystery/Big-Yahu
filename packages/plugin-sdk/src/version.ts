/**
 * The plugin contract's own version, bumped whenever anything a plugin depends
 * on changes shape — a hook's arguments, what a tool handler is handed, what a
 * page must return. A plugin declares the version it was written against, in
 * `bigYahu.apiVersion` in its package.json, and it must match exactly.
 *
 * Exact, not "same major", because the failure being prevented is a plugin
 * running against a contract it does not understand, and a partial match is
 * precisely the fuzzy version of that. A mismatch loads the plugin as
 * incompatible rather than crashing the bot: it is listed in the panel with the
 * reason, and none of its hooks, tools or pages are reachable.
 *
 * **This package's major version is the contract version.** Depend on
 * `"@big-yahu/plugin-sdk": "^2"` and you have declared which contract you
 * speak — there is no second field to keep in step, and updating the SDK is
 * the whole of updating your declaration.
 *
 * It is read from your package.json rather than from this constant, because the
 * bot checks compatibility *before* importing your entry file: a plugin written
 * against a contract the host does not speak may do anything at import time, and
 * running its top level to find out it should not have run is the wrong order.
 */
export const PLUGIN_API_VERSION = 2;

/** What the bot reads out of a plugin's package.json. */
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  /** Entry file relative to the plugin directory. */
  main: string;
  /** The contract version this plugin declares, or null when it declares none. */
  apiVersion: number | null;
  /** Where that number came from, so a mismatch can say what to change. */
  apiVersionSource: 'sdk-dependency' | 'manifest-field' | null;
  /** Set when the SDK dependency and the explicit field disagree with each other. */
  apiVersionConflict: string | null;
}
