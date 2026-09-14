import type { FactType } from './factTypes';

export interface FactMetadata {
  guildId: string;
  channelId: string;
  messageIds: string[];
  /** Everyone whose messages this fact came from. */
  authorIds: string[];
  /**
   * Everyone the fact is *about*, from the mentions in its text. Kept apart from
   * `authorIds` because they answer different questions, and recall matches on
   * it exactly rather than hoping the embedding noticed an id.
   */
  subjectIds?: string[];
  /** Channels the fact names. */
  channelRefs?: string[];
  /**
   * What kind of thing this fact is — several at once, since nearly anything
   * that says something is also a `message`. Absent means nobody has typed it
   * yet, which every type search includes rather than skipping.
   */
  types?: string[];
  /** The first and last day the fact talks about, in whole days since the epoch. */
  dateMin?: number;
  dateMax?: number;
  referencedFactIds: string[];
  timePeriodStart: number;
  timePeriodEnd: number;
  source: 'auto' | 'reply';
  createdAt: number;
}

export interface Fact {
  id: string;
  text: string;
  metadata: FactMetadata;
}

export interface SourceMessage {
  messageId: string;
  channelId: string;
  guildId: string;
  authorId: string;
  authorUsername: string;
  content: string;
  messageCreatedAt: number;
  jumpLink: string;
}

/** A fact plus the resolved text of every message it was derived from. */
export interface FactWithSources extends Fact {
  distance: number | null;
  sourceMessages: SourceMessage[];
  /** Display names for the `<@id>` mentions in `text`, for the admin panel only. */
  mentionNames: Record<string, string>;
}

export interface FactPage {
  facts: FactWithSources[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FactAuthor {
  authorId: string;
  authorUsername: string;
  factCount: number;
}

export interface PluginPanelSummary {
  id: string;
  title: string;
  description?: string;
}

export type PluginPageSummary = PluginPanelSummary;

/**
 * Most of the panel vocabulary is the plugin contract verbatim, so it comes
 * from the SDK rather than being kept in step by hand. Re-exported here so the
 * client keeps importing everything it renders from one place.
 */
export type {
  PanelActionResult,
  PanelElement,
  PanelView,
  PluginField,
  PluginFieldType,
  PluginPageColumn,
  PluginSecretField,
} from '@big-yahu/plugin-sdk';

import type { PanelElement, PluginField, PluginSecretField } from '@big-yahu/plugin-sdk';

/**
 * The three below are deliberately **not** the plugin's versions.
 *
 * A plugin holds ids, because an id survives somebody renaming themselves. The
 * browser needs something a person can read, so the server resolves names on
 * the way out and the wire shape carries both. Keeping the two apart is what
 * lets the plugin side stay honest about storing ids while the panel still
 * shows names — collapsing them would force one side to lie.
 */
export type PluginCell =
  | {
      kind: 'text';
      text: string;
      tone?: 'body' | 'muted' | 'success' | 'error';
      /** Short stand-in for the table; the full `text` opens in a dialog. Set by the plugin. */
      preview?: string;
      /**
       * Names for the `<@id>` and `<#id>` mentions inside `text` and `preview`,
       * keyed by the markup. Filled in by the server; a plugin never sets it.
       */
      mentions?: Record<string, string>;
    }
  | { kind: 'user'; id: string; name: string }
  | { kind: 'channel'; id: string; name: string }
  | { kind: 'number'; value: number; suffix?: string }
  | { kind: 'meter'; value: number; label?: string }
  | { kind: 'time'; at: number }
  | { kind: 'badge'; text: string; tone?: 'ok' | 'warn' | 'error' };

/** Carries the wire `PluginCell` above, so it cannot be the SDK's. */
export interface PluginPageRow {
  id: string;
  cells: Record<string, PluginCell>;
  actions?: Array<{ actionId: string; label: string; tone?: 'default' | 'destructive'; confirm?: string }>;
}

export interface PluginPageData {
  columns: import('@big-yahu/plugin-sdk').PluginPageColumn[];
  rows: PluginPageRow[];
  total: number;
  header?: PanelElement[];
  searchable?: boolean;
  emptyMessage?: string;
  /** Echoed back so the table knows which page it is looking at. */
  page: number;
  pageSize: number;
}

export interface ChannelPermission {
  channelId: string;
  name: string;
  canReply: boolean;
  canExtract: boolean;
}

export interface Controller {
  userId: string;
  label: string;
  addedAt: number;
}

export interface AppSettings {
  checkIntervalMinutes: number;
  replyContextMessages: number;
  factSearchTopK: number;
  escalationLookbackHours: number;
  maxEscalationDepth: number;
  replyLanguage: string;
  timezone: string;
  rateLimitPerHour: number;
  rateLimitMessage: string;
  retryAttempts: number;
  retryDelayMs: number;
  duplicateDistance: number;
  /** Hundredths of a vector distance; 0 means no ceiling. */
  factSearchMaxDistance: number;
  /** What new facts are embedded with; changing either rebuilds the collection. */
  embeddingModel: string;
  embeddingDimensions: number;
  modelFailureThreshold: number;
  modelRestMinutes: number;
  /** Whether pictures are sent to the model at all. Off makes every reply text-only. */
  visionEnabled: boolean;
  /** Ceiling on pictures sent in one model call, newest first. Vision is the expensive part. */
  maxImages: number;
  /** Maximum message.txt file size in KiB; 0 disables reading. Hard cap 64. */
  textAttachmentMaxKb: number;
  /** Messages pulled from another channel the bot was pointed at. 0 turns cross-channel reading off. */
  crossChannelMessages: number;
  /** Every chat model failed. The one case that really is "try again shortly". */
  overloadMessage: string;
  /** The reply ran out of attempts or hit its deadline — the bot's own limit, not the provider's. */
  busyMessage: string;
  /** Something threw, or the model produced no text at all. A bug, said plainly. */
  errorMessage: string;
  /** The key cannot pay. Nothing retries out of this one, so it says so rather than "try again". */
  noCreditsMessage: string;
}

/** One editable system prompt, with what ships alongside whatever replaced it. */
export interface PromptSummary {
  id: 'factExtraction' | 'topicExtraction' | 'reply';
  label: string;
  description: string;
  /** What the bot ships with, so the panel can show what Reset restores. */
  shipped: string;
  /** The operator's version, or null while they are using the shipped one. */
  override: string | null;
  /** Their version describes the old transcript notation, from before the material became JSON. */
  legacyFormat: boolean;
}

export interface ReplyLogEntry {
  id: number;
  guildId: string;
  channelId: string;
  taggedMessageId: string;
  replyMessageId: string | null;
  userId: string;
  content: string;
  factIdsUsed: string[];
  createdAt: number;
  jumpLink: string | null;
}

export interface DashboardStats {
  totalFacts: number;
  totalMessagesReferenced: number;
  totalReplies: number;
  latestReplies: ReplyLogEntry[];
}

/** One row of a task's OpenRouter model list. */
export interface TaskModel {
  task: string;
  model: string;
  /** OpenRouter host the row is pinned to; empty lets OpenRouter choose. */
  upstream: string;
  weight: number;
  consecutiveFailures: number;
  restingUntil: number | null;
  retired: boolean;
  lastError: string | null;
}

/** A row as the panel shows it, with what OpenRouter's catalog says it can do there. */
export interface TaskModelView extends TaskModel {
  /** Null when the catalog does not know the model, or could not be reached. */
  capabilities: { images: boolean; tools: boolean; jsonMode: boolean } | null;
}

export interface AiTaskView {
  id: string;
  label: string;
  description: string;
  usesImages: boolean;
  usesTools: boolean;
  structured: boolean;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  models: TaskModelView[];
  /** Plain-language problems with this list, worst first. */
  warnings: string[];
}

export interface AiTasksOverview {
  tasks: AiTaskView[];
  /** Plugins that send work to a model, and whether they use the shared list. */
  plugins: AiTaskPlugin[];
  openrouterConfigured: boolean;
  catalogAvailable: boolean;
}

export interface AiTaskPlugin {
  pluginId: string;
  pluginName: string;
  useSharedModels: boolean;
  /** The jobs it declares. Each has a list of its own once it is off the shared one. */
  tasks: Array<{ id: string; label: string; description?: string }>;
}

/** A model from OpenRouter's catalog, for the add-a-model search. Prices are dollars per million tokens. */
export interface CatalogModel {
  id: string;
  name: string;
  images: boolean;
  promptPrice: number | null;
  completionPrice: number | null;
}

/** One host serving a model, for the pin picker. Prices are dollars per million tokens, at base rate. */
export interface CatalogEndpoint {
  tag: string;
  providerName: string;
  promptPrice: number | null;
  completionPrice: number | null;
  cacheReadPrice: number | null;
  /** The host charges more at some hours, as DeepSeek does at its peak. */
  timeOfDayPricing: boolean;
  tools: boolean;
  jsonMode: boolean;
  healthy: boolean;
}

/** Sums over a window of model calls. `cost` is US dollars as OpenRouter billed them. */
export interface AiUsageTotals {
  calls: number;
  failures: number;
  cost: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/** The same sums for one task, model or upstream host. */
export interface AiUsageGroup extends AiUsageTotals {
  key: string;
}

export interface AiUsageSummary {
  /** The last 24 hours. */
  day: AiUsageTotals;
  /** The last 7 days; the groups below cover the same window. */
  week: AiUsageTotals;
  byTask: AiUsageGroup[];
  byModel: AiUsageGroup[];
  byProvider: AiUsageGroup[];
}

export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  hooks: string[];
  enabled: boolean;
  config: Record<string, unknown>;
  /** Ships with the bot; cannot be uninstalled from the panel. */
  bundled: boolean;
  /** The plugin API version it declares, or null when it declares none. */
  apiVersion: number | null;
  /** Why it will not run, or null when it will. Set means nothing of it is reachable. */
  incompatibleReason: string | null;
  /** Declared settings, or null when the plugin describes none and gets the JSON editor. */
  configSchema: PluginField[] | null;
  /** Secrets the plugin says it needs. Declared ones can be emptied but not deleted. */
  secrets: PluginSecretField[];
  /** Its data screens, each with its own route. */
  pages: PluginPageSummary[];
}

export interface AuthStatus {
  hasAdmin: boolean;
  authenticated: boolean;
  username: string | null;
}

export type ApiResponse<T> = { success: true; data: T } | { success: false; error: string };

/** The embedding model the fact store is on, against the one that is configured. */
export interface EmbeddingStatus {
  upToDate: boolean;
  source: { model: string; dimensions: number; collection: string; exists: boolean; facts: number };
  target: { model: string; dimensions: number; collection: string };
  job: {
    id: number;
    status: 'running' | 'paused' | 'failed' | 'complete';
    total: number;
    copied: number;
    sourceModel: string;
    targetModel: string;
    targetDimensions: number;
    /** Recall answers nothing while this is true. */
    pausesRecall: boolean;
    lastError: string | null;
    /** Which job this is: both share the runner, the controls and this status. */
    kind: 'reembed' | 'cleanup';
  } | null;
}

export interface FactTypesOverview {
  types: FactType[];
  /** Facts nobody has sorted yet. They surface in every type search until the cleanup pass runs. */
  untypedFacts: number;
}

export interface FactTypeInput {
  id: string;
  label: string;
  description: string;
  duplicateDistance?: number;
  factSearchTopK?: number;
  factSearchMaxDistance?: number;
}

export interface CleanupStatus {
  /** How many facts the chosen filter would go over. */
  facts: number;
  /** Facts nobody has sorted yet — the reason to run it at all. */
  untyped: number;
  collection: string;
  job: EmbeddingStatus['job'];
}
