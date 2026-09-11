export interface FactMetadata {
  guildId: string;
  channelId: string;
  messageIds: string[];
  /** Everyone whose messages this fact came from, so facts can be filtered per person. */
  authorIds: string[];
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

export interface ChatModel {
  model: string;
  weight: number;
  consecutiveFailures: number;
  restingUntil: number | null;
  lastError: string | null;
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
  chatModel: string;
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
  /** The reply ran out of attempts or hit its deadline — the bot's own limit, not Gemini's. */
  busyMessage: string;
  /** Something threw, or the model produced no text at all. A bug, said plainly. */
  errorMessage: string;
}

/** One editable system prompt, with what ships alongside whatever replaced it. */
export interface PromptSummary {
  id: 'factExtraction' | 'topicExtraction' | 'reply';
  label: string;
  description: string;
  /** Substituted at call time. A saved prompt missing one of these is refused. */
  placeholders: readonly string[];
  /** Appended after the body and not editable, or null where there is none. */
  floor: string | null;
  /** What the bot ships with, so the panel can show what Reset restores. */
  shipped: string;
  /** The operator's version, or null while they are using the shipped one. */
  override: string | null;
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
