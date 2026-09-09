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
 * This package's major version tracks it, so `"@big-yahu/plugin-sdk": "^1"`
 * says exactly which contract a plugin speaks and npm enforces it for you.
 */
export const PLUGIN_API_VERSION = 1;

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
}
