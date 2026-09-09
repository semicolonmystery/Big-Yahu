import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from 'discord.js';
import { mentionsIn, readMention } from '@shared/discord';
import { getFactsCollection } from '../db/chroma';
import { addFacts } from '../db/repositories/factsRepo';
import { ai } from '../ai/client';
import { generate } from '../ai/generate';
import { getState, listStates, seedPlugin, setState } from '../db/repositories/pluginStateRepo';
import { listEnvKeys, readEnv, setEnv } from '../db/repositories/pluginEnvRepo';
import { storageFor } from '../db/repositories/pluginStorageRepo';
import { closeAllDatabases, databaseFor } from './database';
import { HOOK_NAMES } from '@big-yahu/plugin-sdk';
import {
  BUNDLED_DIR,
  PLUGINS_DIR,
  incompatibilityReason,
  linkNodeModules,
  readManifest,
  type PluginManifest,
} from './manifest';
import { coerceConfig, isUsableField, isUsableSecret } from './configSchema';
import { knownDisplayNames } from '../bot/identity';
import { getUsernames } from '../db/repositories/cachedMessagesRepo';
import type {
  AnnotateContextContext,
  AnnotateExtractionContext,
  ContextAnnotations,
  PluginPage,
  PluginPageData,
  PluginCell,
  ContextUser,
  PanelActionResult,
  PanelElement,
  PanelView,
  PluginPanel,
  PluginTool,
  BeforeReplyContext,
  BeforeReplyResult,
  BigYahuPlugin,
  DraftPrompt,
  OnBotTaggedContext,
  OnHourlyCheckContext,
  OnMessageContext,
  PluginContext,
} from '@big-yahu/plugin-sdk';
import type { FunctionDeclaration } from '@google/genai';
import type {
  PluginSummary,
  PluginCell as WirePluginCell,
  PluginPageData as WirePluginPageData,
} from '@shared/types';

const registry = new Map<string, BigYahuPlugin>();
const manifests = new Map<string, PluginManifest>();
const bundledIds = new Set<string>();
/**
 * Plugins that loaded but must not run — today, one built against a different
 * plugin API version. Kept apart from `registry` rather than filtered at every
 * call site: the ways to reach a plugin's code are hooks, tools, panels, pages
 * and instructions, and something would eventually be added without the filter.
 * Never being in the registry means none of them can find it.
 */
const incompatible = new Map<string, { manifest: PluginManifest; reason: string }>();
/**
 * Plugins that could not be loaded at all — a missing dependency, a native
 * binding that never built, a syntax error. Kept because without it they existed
 * nowhere: not in the registry, not in `incompatible`, just a line on stdout,
 * so the panel showed nothing and an operator had no way to tell an
 * installed-but-broken plugin from one that was never installed.
 */
const failed = new Map<string, { manifest: PluginManifest; reason: string }>();
let discordClient: Client | null = null;

/**
 * Identity comes from package.json, so the export only has to carry something
 * the bot can use: a hook, a tool, or instructions. A tools-only plugin is
 * perfectly normal and has no hooks at all.
 */
function isPlugin(value: unknown): value is Omit<BigYahuPlugin, 'id'> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const hasHook = HOOK_NAMES.some((hook) => typeof candidate[hook] === 'function');
  const hasTools = Array.isArray(candidate.tools) && candidate.tools.length > 0;
  const hasInstructions = typeof candidate.instructions === 'string' || typeof candidate.instructions === 'function';
  const hasPanels = Array.isArray(candidate.panels) && candidate.panels.length > 0;
  const hasPages = Array.isArray(candidate.pages) && candidate.pages.length > 0;
  return hasHook || hasTools || hasInstructions || hasPanels || hasPages;
}

/** Hooks need a live Discord client; discovery and the admin panel do not. */
export function attachDiscordClient(client: Client): void {
  discordClient = client;
}

export async function loadPlugins(): Promise<void> {
  // A replaced plugin must not leave a file handle open on its old database.
  closeAllDatabases();
  registry.clear();
  manifests.clear();
  bundledIds.clear();
  incompatible.clear();
  failed.clear();
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  linkNodeModules();

  for (const directory of [BUNDLED_DIR, PLUGINS_DIR]) {
    if (!fs.existsSync(directory)) continue;
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      // Directory order is filesystem-dependent; beforeReply chains, so sort.
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      await loadOne(path.join(directory, entry.name), directory === BUNDLED_DIR);
    }
  }
  console.log(
    `[plugins] loaded ${registry.size} plugin(s)`
    + (incompatible.size > 0 ? `, ${incompatible.size} refused for the wrong API version` : '')
    + (failed.size > 0 ? `, ${failed.size} failed to load` : ''),
  );
}

async function loadOne(directory: string, bundled: boolean): Promise<void> {
  let manifest: PluginManifest;
  try {
    manifest = readManifest(directory);
  } catch (error) {
    console.error(`[plugins] ignoring ${path.basename(directory)}:`, error instanceof Error ? error.message : error);
    return;
  }

  // Checked before the entry file is imported. A plugin written against another
  // contract may do anything at import time, and running its top level to find
  // out it should not have run is the wrong order.
  const refusal = incompatibilityReason(manifest);
  if (refusal) {
    incompatible.set(manifest.id, { manifest, reason: refusal });
    if (bundled) bundledIds.add(manifest.id);
    console.error(`[plugins] ${manifest.id} will not run: ${refusal}`);
    return;
  }

  try {
    // The query string defeats the module cache, so a reinstall takes effect
    // without restarting the process.
    const entry = pathToFileURL(path.join(directory, manifest.main)).href + `?v=${Date.now()}`;
    const module: unknown = await import(entry);
    const exported = (module as { default?: unknown }).default;
    const plugin = isPlugin(exported) ? exported : undefined;
    if (!plugin) {
      const reason = 'Its default export has no hooks, tools, panels, pages or instructions.';
      failed.set(manifest.id, { manifest, reason });
      if (bundled) bundledIds.add(manifest.id);
      console.error(`[plugins] ${manifest.id}: ${reason}`);
      return;
    }

    // package.json is the source of truth for identity, so it wins over the export.
    const resolved: BigYahuPlugin = {
      ...plugin,
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
    };
    registry.set(manifest.id, resolved);
    manifests.set(manifest.id, manifest);
    if (bundled) bundledIds.add(manifest.id);
    // Always off. Installing a plugin is running its author's code as the bot,
    // and a plugin that could switch itself on would decide that for the operator
    // — including on an update, where nobody went looking for a new switch.
    seedPlugin(manifest.id, false, resolved.defaultConfig ?? {});
    seedSecrets(manifest.id, resolved);
  } catch (error) {
    // Usually a dependency: a package that was never installed, or a native
    // module whose binding did not build. The message is what an operator needs
    // to act on, so it goes to the panel rather than only to stdout.
    const reason = error instanceof Error ? error.message : String(error);
    failed.set(manifest.id, { manifest, reason });
    if (bundled) bundledIds.add(manifest.id);
    console.error(`[plugins] failed to load ${manifest.id}:`, error);
  }
}

/**
 * Writes the defaults for any declared secret that has never been set. Only ever
 * fills a gap — an operator's value is never overwritten, and a secret they have
 * deliberately emptied stays empty, because a default reappearing after you
 * cleared it is indistinguishable from the panel ignoring you.
 */
function seedSecrets(pluginId: string, plugin: BigYahuPlugin): void {
  const declared = (plugin.secrets ?? []).filter(isUsableSecret).filter((secret) => secret.default !== undefined);
  if (declared.length === 0) return;

  const existing = new Set(listEnvKeys(pluginId));
  const seeds = Object.fromEntries(
    declared.filter((secret) => !existing.has(secret.name)).map((secret) => [secret.name, secret.default as string]),
  );
  if (Object.keys(seeds).length > 0) setEnv(pluginId, seeds);
}

function isDraftPrompt(value: unknown): value is DraftPrompt {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DraftPrompt>;
  return (
    typeof candidate.systemInstruction === 'string'
    && Array.isArray(candidate.conversation)
    && Array.isArray(candidate.retrievedFacts)
    && Array.isArray(candidate.sourceMessages)
  );
}

function enabledPlugins(): BigYahuPlugin[] {
  const states = listStates();
  return [...registry.values()].filter((plugin) => states[plugin.id]?.enabled);
}

/**
 * Everything a plugin is handed.
 *
 * **Nothing on this boundary may use `instanceof`, and no host library function
 * may be handed an object a plugin constructed.** That is what lets a plugin
 * install its own copy of `discord.js` or `drizzle-orm` and still work: it reads
 * properties off host-built objects and calls methods on them, all duck-typed,
 * and what it returns is checked structurally (see `isDraftPrompt`). Introduce
 * one `instanceof` here and every plugin carrying its own copy of that library
 * breaks, in a way that looks like the plugin's fault.
 */
async function baseContext(pluginId: string): Promise<PluginContext> {
  const factsCollection = await getFactsCollection();
  // Frozen so one plugin cannot swap a function in and have another call it.
  // `database` is a getter so no file is created for a plugin that never uses it.
  return Object.freeze({
    factsCollection,
    saveFacts: addFacts,
    resolveUserNames,
    generate,
    ai,
    discordClient,
    getConfig: <T = Record<string, unknown>>() => (getState(pluginId)?.config ?? {}) as T,
    getEnv: () => readEnv(pluginId),
    storage: storageFor(pluginId),
    get database() {
      return databaseFor(pluginId);
    },
  });
}

/** A plugin throwing is logged and swallowed — it must never take a pipeline down with it. */
async function safely(pluginId: string, hook: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(`[plugins] ${pluginId}.${hook} threw:`, error);
  }
}

export async function runOnMessage(payload: Omit<OnMessageContext, keyof PluginContext>): Promise<void> {
  for (const plugin of enabledPlugins()) {
    if (!plugin.onMessage) continue;
    const ctx = { ...(await baseContext(plugin.id)), ...payload };
    await safely(plugin.id, 'onMessage', () => plugin.onMessage!(ctx));
  }
}

export async function runOnHourlyCheck(payload: Omit<OnHourlyCheckContext, keyof PluginContext>): Promise<void> {
  for (const plugin of enabledPlugins()) {
    if (!plugin.onHourlyCheck) continue;
    const ctx = { ...(await baseContext(plugin.id)), ...payload };
    await safely(plugin.id, 'onHourlyCheck', () => plugin.onHourlyCheck!(ctx));
  }
}

export async function runOnBotTagged(payload: Omit<OnBotTaggedContext, keyof PluginContext>): Promise<void> {
  for (const plugin of enabledPlugins()) {
    if (!plugin.onBotTagged) continue;
    const ctx = { ...(await baseContext(plugin.id)), ...payload };
    await safely(plugin.id, 'onBotTagged', () => plugin.onBotTagged!(ctx));
  }
}

function annotationLines(
  annotations: Array<{ pluginName: string; annotations: ContextAnnotations }>,
  key: 'users' | 'facts' | 'messages',
  label: (id: string) => string,
): string[] {
  const bySubject = new Map<string, string[]>();
  for (const { pluginName, annotations: contributed } of annotations) {
    for (const [id, line] of Object.entries(contributed[key] ?? {})) {
      if (typeof line !== 'string' || !line.trim()) continue;
      const existing = bySubject.get(id) ?? [];
      existing.push(`${pluginName}: ${line.trim()}`);
      bySubject.set(id, existing);
    }
  }
  return [...bySubject.entries()].map(([id, lines]) => `- ${label(id)} — ${lines.join(' | ')}`);
}

/**
 * Runs every enabled plugin's annotateContext and renders what they contribute
 * into one prompt section. Plugins are asked in parallel: unlike beforeReply
 * this is not a chain, and none of them sees another's answer.
 */
export async function collectAnnotations(
  payload: Omit<AnnotateContextContext, keyof PluginContext>,
): Promise<string> {
  const collected: Array<{ pluginName: string; annotations: ContextAnnotations }> = [];

  for (const plugin of enabledPlugins()) {
    if (!plugin.annotateContext) continue;
    const ctx: AnnotateContextContext = { ...(await baseContext(plugin.id)), ...payload };
    try {
      const result = await plugin.annotateContext(ctx);
      if (result) collected.push({ pluginName: plugin.name, annotations: result });
    } catch (error) {
      console.error(`[plugins] ${plugin.id}.annotateContext threw:`, error);
    }
  }
  if (collected.length === 0) return '';

  const usersById = new Map<string, ContextUser>(payload.users.map((user) => [user.id, user]));
  const factsById = new Map(payload.facts.map((fact) => [fact.id, fact]));

  const sections: string[] = [];

  const userLines = annotationLines(collected, 'users', (id) => {
    const user = usersById.get(id);
    return user ? `<@${id}> (${user.displayName})` : `<@${id}>`;
  });
  if (userLines.length > 0) sections.push(`About the people here:\n${userLines.join('\n')}`);

  const messageLines = annotationLines(collected, 'messages', (id) => `[id=${id}]`);
  if (messageLines.length > 0) sections.push(`About specific messages:\n${messageLines.join('\n')}`);

  const factLines = annotationLines(collected, 'facts', (id) => {
    const fact = factsById.get(id);
    return fact ? `[factId=${id}] ${fact.text.slice(0, 80)}` : `[factId=${id}]`;
  });
  if (factLines.length > 0) sections.push(`About what you remember:\n${factLines.join('\n')}`);

  const notes = collected
    .filter((entry) => typeof entry.annotations.notes === 'string' && entry.annotations.notes.trim())
    .map((entry) => `${entry.pluginName}: ${entry.annotations.notes!.trim()}`);
  if (notes.length > 0) sections.push(notes.join('\n'));

  if (sections.length === 0) return '';

  return (
    'What your plugins know about this conversation. This is true and current — '
    + 'act on it, but never read it out, quote it, or tell anyone what it says.\n\n'
    + sections.join('\n\n')
  );
}

/**
 * Chained: each plugin sees the previous plugin's edits, and the first plugin to
 * ask for a skip stops the chain and the reply.
 */
/**
 * The extraction pass's counterpart to collectAnnotations, and deliberately a
 * different function with a different hook behind it. A plugin has to ask to be
 * here; nothing written for annotateContext is dragged into the pass that
 * decides what gets remembered forever.
 *
 * Free text rather than keyed lines: there is no per-user or per-fact rendering
 * to hang it on, and what a plugin has to say about a whole window does not fit
 * a key. Each plugin's contribution is labelled with its name and fenced off in
 * the prompt as background rather than material.
 */
export async function collectExtractionAnnotations(
  payload: Omit<AnnotateExtractionContext, keyof PluginContext>,
): Promise<string> {
  const notes: string[] = [];

  for (const plugin of enabledPlugins()) {
    if (!plugin.annotateExtraction) continue;
    const ctx: AnnotateExtractionContext = { ...(await baseContext(plugin.id)), ...payload };
    try {
      const result = await plugin.annotateExtraction(ctx);
      if (typeof result === 'string' && result.trim()) notes.push(`${plugin.name}: ${result.trim()}`);
    } catch (error) {
      console.error(`[plugins] ${plugin.id}.annotateExtraction threw:`, error);
    }
  }

  if (notes.length === 0) return '';

  return (
    'Background from your plugins. It is here so you can make sense of the messages — who "he" is, what '
    + '"the thing" refers to — and nothing more. It is not material to extract: never turn a line of it into '
    + 'a fact, and never let it decide what a message meant when the message says otherwise.\n\n'
    + notes.join('\n')
  );
}

export async function runBeforeReply(
  payload: Omit<BeforeReplyContext, keyof PluginContext>,
): Promise<{ draftPrompt: DraftPrompt; skipReply: boolean }> {
  let draftPrompt = payload.draftPrompt;

  for (const plugin of enabledPlugins()) {
    if (!plugin.beforeReply) continue;
    const ctx: BeforeReplyContext = { ...(await baseContext(plugin.id)), ...payload, draftPrompt };

    let result: BeforeReplyResult | void;
    try {
      result = await plugin.beforeReply(ctx);
    } catch (error) {
      console.error(`[plugins] ${plugin.id}.beforeReply threw:`, error);
      continue;
    }

    if (result?.draftPrompt) {
      if (isDraftPrompt(result.draftPrompt)) {
        draftPrompt = result.draftPrompt;
      } else {
        console.error(
          `[plugins] ${plugin.id}.beforeReply returned a malformed draftPrompt; keeping the previous one. `
            + 'It must be the whole object, not a patch.',
        );
      }
    }
    if (result?.skipReply) return { draftPrompt, skipReply: true };
  }

  return { draftPrompt, skipReply: false };
}

function usableSchema(plugin: BigYahuPlugin): PluginSummary['configSchema'] {
  const declared = (plugin.configSchema ?? []).filter(isUsableField);
  return declared.length > 0 ? declared : null;
}

/** The declared secrets for a plugin, which the panel must not offer to delete. */
export function declaredSecretNames(pluginId: string): Set<string> {
  const plugin = registry.get(pluginId);
  return new Set((plugin?.secrets ?? []).filter(isUsableSecret).map((secret) => secret.name));
}

export function listPluginSummaries(): PluginSummary[] {
  const states = listStates();

  const running: PluginSummary[] = [...registry.values()].map((plugin) => ({
    id: plugin.id,
    name: manifests.get(plugin.id)?.name ?? plugin.name,
    description: manifests.get(plugin.id)?.description ?? plugin.description,
    version: manifests.get(plugin.id)?.version ?? plugin.version,
    hooks: [
      ...HOOK_NAMES.filter((hook) => typeof plugin[hook] === 'function'),
      ...(plugin.tools ?? []).map((tool) => `tool:${tool.name}`),
    ],
    enabled: states[plugin.id]?.enabled ?? false,
    config: states[plugin.id]?.config ?? {},
    bundled: bundledIds.has(plugin.id),
    apiVersion: manifests.get(plugin.id)?.apiVersion ?? null,
    incompatibleReason: null,
    // A malformed field is dropped rather than failing the whole list, but a
    // plugin whose every field is malformed falls back to the JSON editor rather
    // than showing an empty form that saves nothing.
    configSchema: usableSchema(plugin),
    secrets: (plugin.secrets ?? []).filter(isUsableSecret),
    pages: listPages(plugin.id),
  }));

  // Listed rather than hidden. A plugin that silently vanished from the panel
  // after an update reads as the panel being broken, not the plugin.
  const unusable = (
    entries: Iterable<{ manifest: PluginManifest; reason: string }>,
  ): PluginSummary[] => [...entries].map(({ manifest, reason }) => ({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    hooks: [],
    enabled: false,
    config: states[manifest.id]?.config ?? {},
    bundled: bundledIds.has(manifest.id),
    apiVersion: manifest.apiVersion,
    incompatibleReason: reason,
    configSchema: null,
    secrets: [],
    pages: [],
  }));

  return [...running, ...unusable(incompatible.values()), ...unusable(failed.values())];
}

export function updatePluginState(id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): void {
  const refused = incompatible.get(id) ?? failed.get(id);
  if (refused) throw new Error(`${id} cannot run: ${refused.reason}`);
  const plugin = registry.get(id);
  if (!plugin) throw new Error(`Unknown plugin: ${id}`);

  // Only when the plugin said what it wants. Without a schema there is nothing
  // to check against, and the JSON the operator typed is stored as it always was.
  const schema = usableSchema(plugin);
  if (patch.config && schema) {
    const { config, missing } = coerceConfig(schema, patch.config, getState(id)?.config ?? {});
    if (missing.length > 0) throw new Error(`${missing.join(', ')} cannot be empty`);
    setState(id, { ...patch, config });
    return;
  }

  setState(id, patch);
}

export function isBundled(id: string): boolean {
  return bundledIds.has(id);
}

export function knownPluginIds(): string[] {
  return [...registry.keys(), ...incompatible.keys(), ...failed.keys()];
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,48}$/;

/** Namespaced so two plugins can both ship a "lookup" without clashing. */
function qualifiedName(pluginId: string, tool: PluginTool): string {
  return `${pluginId.replace(/-/g, '_')}__${tool.name}`;
}

export interface ResolvedTool {
  declaration: FunctionDeclaration;
  pluginId: string;
  tool: PluginTool;
}

/** Tools from every enabled plugin, ready to hand to the model. */
export function collectTools(): ResolvedTool[] {
  const resolved: ResolvedTool[] = [];
  for (const plugin of enabledPlugins()) {
    for (const tool of plugin.tools ?? []) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        console.error(`[plugins] ${plugin.id}: tool "${tool.name}" has an unusable name, skipping`);
        continue;
      }
      resolved.push({
        pluginId: plugin.id,
        tool,
        declaration: {
          name: qualifiedName(plugin.id, tool),
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        },
      });
    }
  }
  return resolved;
}

/**
 * Runs a plugin tool and returns whatever the model should see. A thrown
 * handler becomes an error payload rather than killing the reply — the model
 * can then say it could not look something up.
 */
export async function runTool(resolved: ResolvedTool, args: Record<string, unknown>): Promise<unknown> {
  try {
    const ctx = await baseContext(resolved.pluginId);
    const result = await resolved.tool.handler(args, ctx);
    return result ?? { ok: true };
  } catch (error) {
    console.error(`[plugins] ${resolved.pluginId}.${resolved.tool.name} threw:`, error);
    return { error: error instanceof Error ? error.message : 'The tool failed' };
  }
}

/** Extra system-prompt text contributed by enabled plugins. */
export async function collectInstructions(): Promise<string[]> {
  const lines: string[] = [];
  for (const plugin of enabledPlugins()) {
    if (!plugin.instructions) continue;
    try {
      const text =
        typeof plugin.instructions === 'function'
          ? plugin.instructions(await baseContext(plugin.id))
          : plugin.instructions;
      if (text.trim()) lines.push(text.trim());
    } catch (error) {
      console.error(`[plugins] ${plugin.id}.instructions threw:`, error);
    }
  }
  return lines;
}

/**
 * Panels are declarative, so nothing a plugin returns becomes markup. Images
 * are still restricted to data: and https: — a plugin should not be able to
 * point the admin's browser at an arbitrary host and phone home.
 */
function sanitiseElement(element: PanelElement): PanelElement | null {
  if (element.type === 'image') {
    const src = element.src.trim();
    if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/i.test(src) && !/^https:\/\//i.test(src)) {
      console.error('[plugins] dropped a panel image whose src is neither a data: image nor https');
      return null;
    }
    return { ...element, src };
  }
  return element;
}

function sanitiseView(view: PanelView): PanelView {
  return {
    elements: (view.elements ?? []).map(sanitiseElement).filter((element) => element !== null),
    pollSeconds:
      typeof view.pollSeconds === 'number' && view.pollSeconds >= 2 ? Math.min(view.pollSeconds, 300) : undefined,
  };
}

function findPanel(pluginId: string, panelId: string): { plugin: BigYahuPlugin; panel: PluginPanel } | null {
  const plugin = registry.get(pluginId);
  const panel = plugin?.panels?.find((entry) => entry.id === panelId);
  return plugin && panel ? { plugin, panel } : null;
}

export function listPanels(pluginId: string): Array<{ id: string; title: string; description?: string }> {
  return (registry.get(pluginId)?.panels ?? []).map((panel) => ({
    id: panel.id,
    title: panel.title,
    description: panel.description,
  }));
}

export async function renderPanel(pluginId: string, panelId: string): Promise<PanelView> {
  const found = findPanel(pluginId, panelId);
  if (!found) throw new Error(`No panel "${panelId}" on plugin "${pluginId}"`);

  try {
    return sanitiseView(await found.panel.render(await baseContext(pluginId)));
  } catch (error) {
    console.error(`[plugins] ${pluginId}.${panelId}.render threw:`, error);
    return {
      elements: [
        { type: 'text', tone: 'error', text: error instanceof Error ? error.message : 'The panel failed to load' },
      ],
    };
  }
}

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

function findPage(pluginId: string, pageId: string): { plugin: BigYahuPlugin; page: PluginPage } | null {
  const plugin = registry.get(pluginId);
  const page = plugin?.pages?.find((entry) => entry.id === pageId);
  return plugin && page ? { plugin, page } : null;
}

export function listPages(pluginId: string): Array<{ id: string; title: string; description?: string }> {
  return (registry.get(pluginId)?.pages ?? []).map((page) => ({
    id: page.id,
    title: page.title,
    description: page.description,
  }));
}

/**
 * Turns the ids a plugin stores into names an operator can read.
 *
 * A plugin holds `<@id>` because that is what survives somebody renaming
 * themselves — the whole reason facts stopped storing display names. That makes
 * it exactly the wrong thing to put in a table: a column of raw snowflakes tells
 * the person reading it nothing at all. So the ids stay in the plugin and the
 * names are resolved here, on the way out, from the gateway first and the
 * message cache behind it. An id nothing can name falls back to itself.
 */
/** The gateway knows current display names; the message cache remembers people it has not seen lately. */
function resolveUserNames(ids: string[]): Record<string, string> {
  if (ids.length === 0) return {};
  return { ...getUsernames(ids), ...knownDisplayNames(ids) };
}

function resolveCells(rows: PluginPageData['rows']): WirePluginPageData['rows'] {
  // A `user` cell holds an id, and so does a mention inside a `text` cell — a
  // rolling memory is written as "<@1049…> spam emails sent to …", which is
  // right for storage and unreadable in a table. Both are collected in one pass
  // so the lookup happens once for the page rather than once per row.
  const userIds: string[] = [];
  const markup = new Set<string>();
  for (const row of rows) {
    for (const cell of Object.values(row.cells)) {
      if (cell.kind === 'user') userIds.push(cell.id);
      if (cell.kind === 'text') {
        for (const mention of mentionsIn(cell.text)) {
          markup.add(mention);
          const { id, isChannel } = readMention(mention);
          if (!isChannel) userIds.push(id);
        }
      }
    }
  }

  const names = resolveUserNames(userIds);
  const channels = discordClient?.channels.cache;

  const channelName = (id: string): string => {
    const channel = channels?.get(id);
    return channel && 'name' in channel && channel.name ? `#${channel.name}` : `#${id}`;
  };

  // Resolved once for the whole page, then handed to every cell that needs it.
  const mentionNames: Record<string, string> = {};
  for (const mention of markup) {
    const { id, isChannel } = readMention(mention);
    mentionNames[mention] = isChannel ? channelName(id) : (names[id] ?? id);
  }

  const resolve = (cell: PluginCell): WirePluginCell => {
    if (cell.kind === 'user') return { ...cell, name: names[cell.id] ?? cell.id };
    if (cell.kind === 'channel') return { ...cell, name: channelName(cell.id) };
    if (cell.kind === 'text') {
      const present = mentionsIn(cell.text);
      if (present.length === 0) return cell;
      return {
        ...cell,
        mentions: Object.fromEntries(present.map((mention) => [mention, mentionNames[mention]])),
      };
    }
    return cell;
  };

  return rows.map((row) => ({
    ...row,
    cells: Object.fromEntries(Object.entries(row.cells).map(([key, cell]) => [key, resolve(cell)])),
  }));
}

export async function renderPage(
  pluginId: string,
  pageId: string,
  request: { page?: number; pageSize?: number; query?: string },
): Promise<WirePluginPageData> {
  const found = findPage(pluginId, pageId);
  if (!found) throw new Error(`No page "${pageId}" on plugin "${pluginId}"`);

  const page = Math.max(1, Math.floor(request.page ?? 1));
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(request.pageSize ?? PAGE_SIZE_DEFAULT)));
  const query = (request.query ?? '').trim();

  try {
    const data = await found.page.render(await baseContext(pluginId), { page, pageSize, query });
    return {
      columns: data.columns ?? [],
      rows: resolveCells(data.rows ?? []),
      total: typeof data.total === 'number' ? data.total : (data.rows ?? []).length,
      header: (data.header ?? []).map(sanitiseElement).filter((element) => element !== null),
      searchable: data.searchable ?? false,
      emptyMessage: data.emptyMessage,
      page,
      pageSize,
    };
  } catch (error) {
    console.error(`[plugins] ${pluginId}.${pageId}.render threw:`, error);
    return {
      columns: [],
      rows: [],
      total: 0,
      header: [
        { type: 'text', tone: 'error', text: error instanceof Error ? error.message : 'The page failed to load' },
      ],
      page,
      pageSize,
    };
  }
}

export async function runPageAction(
  pluginId: string,
  pageId: string,
  actionId: string,
  rowId: string,
): Promise<PanelActionResult> {
  const found = findPage(pluginId, pageId);
  if (!found) throw new Error(`No page "${pageId}" on plugin "${pluginId}"`);
  if (!found.page.action) return { tone: 'error', message: 'This page takes no actions' };

  try {
    return (await found.page.action(actionId, rowId, await baseContext(pluginId))) ?? {};
  } catch (error) {
    console.error(`[plugins] ${pluginId}.${pageId}.${actionId} threw:`, error);
    return { tone: 'error', message: error instanceof Error ? error.message : 'The action failed' };
  }
}

export async function runPanelAction(
  pluginId: string,
  panelId: string,
  actionId: string,
  values: Record<string, string>,
): Promise<PanelActionResult> {
  const found = findPanel(pluginId, panelId);
  if (!found) throw new Error(`No panel "${panelId}" on plugin "${pluginId}"`);
  if (!found.panel.action) return { tone: 'error', message: 'This panel takes no actions' };

  try {
    const result = (await found.panel.action(actionId, values, await baseContext(pluginId))) ?? {};
    return result.view ? { ...result, view: sanitiseView(result.view) } : result;
  } catch (error) {
    console.error(`[plugins] ${pluginId}.${panelId}.${actionId} threw:`, error);
    return { tone: 'error', message: error instanceof Error ? error.message : 'The action failed' };
  }
}
