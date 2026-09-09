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

/** Mirrors `PluginField` on the server; the panel renders a control per type. */
export type PluginFieldType = 'string' | 'text' | 'number' | 'boolean' | 'select' | 'list';

export interface PluginField {
  name: string;
  label: string;
  type: PluginFieldType;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  itemType?: 'string' | 'number';
  required?: boolean;
}

export interface PluginSecretField {
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  default?: string;
}

/**
 * A page's cell as it reaches the browser. `user` and `channel` arrive carrying
 * both the id and the name the server resolved for it — the id is what the
 * plugin stores, the name is what an operator can actually read.
 */
export type PluginCell =
  | {
      kind: 'text';
      text: string;
      tone?: 'body' | 'muted' | 'success' | 'error';
      /**
       * Names for the `<@id>` and `<#id>` mentions inside `text`, keyed by the
       * markup. Filled in by the server; a plugin never sets it.
       */
      mentions?: Record<string, string>;
    }
  | { kind: 'user'; id: string; name: string }
  | { kind: 'channel'; id: string; name: string }
  | { kind: 'number'; value: number; suffix?: string }
  | { kind: 'meter'; value: number; label?: string }
  | { kind: 'time'; at: number }
  | { kind: 'badge'; text: string; tone?: 'ok' | 'warn' | 'error' };

export interface PluginPageColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  secondary?: boolean;
}

export interface PluginPageRow {
  id: string;
  cells: Record<string, PluginCell>;
  actions?: Array<{ actionId: string; label: string; tone?: 'default' | 'destructive'; confirm?: string }>;
}

export interface PluginPageData {
  columns: PluginPageColumn[];
  rows: PluginPageRow[];
  total: number;
  header?: PanelElement[];
  searchable?: boolean;
  emptyMessage?: string;
  /** Echoed back so the table knows which page it is looking at. */
  page: number;
  pageSize: number;
}

export type PanelElement =
  | { type: 'text'; text: string; tone?: 'body' | 'muted' | 'success' | 'error' }
  | { type: 'heading'; text: string }
  | { type: 'status'; label: string; value: string; tone?: 'ok' | 'warn' | 'error' }
  | { type: 'image'; src: string; alt?: string; caption?: string }
  | {
      type: 'field';
      name: string;
      label: string;
      inputType?: 'text' | 'password' | 'number';
      placeholder?: string;
      value?: string;
      help?: string;
    }
  | { type: 'button'; actionId: string; label: string; tone?: 'default' | 'destructive'; confirm?: string }
  | { type: 'divider' };

export interface PanelView {
  elements: PanelElement[];
  pollSeconds?: number;
}

export interface PanelActionResult {
  message?: string;
  tone?: 'success' | 'error';
  view?: PanelView;
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
  /** Messages pulled from another channel the bot was pointed at. 0 turns cross-channel reading off. */
  crossChannelMessages: number;
  overloadMessage: string;
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
