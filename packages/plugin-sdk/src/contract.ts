import type { Client, Message } from 'discord.js';
import type {
  Content,
  ContentListUnion,
  GenerateContentConfig,
  GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import type { Collection } from 'chromadb';
import type { Database } from 'better-sqlite3';
import type { Fact, FactCandidate, PluginStorage, SourceMessage } from './data';

/**
 * What a plugin is handed. Everything here is either shared on purpose (the
 * bot's memory, the Discord client) or scoped to this plugin alone. The raw
 * database is deliberately absent: it would have let any plugin read every
 * other plugin's secrets.
 */
export interface PluginContext {
  /** The bot's shared memory. Facts are common ground, not private to a plugin. */
  factsCollection: Collection;
  /**
   * Writes facts the way the bot writes them — embedded, deduped against what is
   * already stored, dated absolutely, with the right metadata. Going at
   * `factsCollection` directly bypasses all of that, so anything meant to last
   * should come through here. Returns the ids actually created; a candidate that
   * duplicates an existing fact creates nothing, which is the point.
   */
  saveFacts(candidates: FactCandidate[]): Promise<string[]>;
  /**
   * Display names for Discord user ids, from the gateway first and the message
   * cache behind it. An id nothing can name is simply absent from the result.
   *
   * A plugin stores ids because that is what survives somebody renaming
   * themselves, which leaves it holding the one thing a person cannot read. Page
   * cells are resolved automatically on the way out, so this is for the cases
   * that are not a cell — searching by name, or writing a name into text.
   */
  resolveUserNames(ids: string[]): Record<string, string>;
  /**
   * Asks a model, through the bot's own pool.
   *
   * Use this rather than `ai.models.generateContent`. The pool is what the
   * operator configures in the panel: several models in a weighted order, tried
   * best-first, with a model that keeps failing counted, rested and skipped, and
   * transient failures retried on the operator's settings. A plugin naming its
   * own model sits outside all of that — it keeps working right up until that one
   * model is the one having a bad day, and then it simply stops, quietly, while
   * the rest of the bot carries on.
   *
   * Throws once every model in the pool has been tried and none answered.
   */
  generate(contents: ContentListUnion, config: GenerateContentConfig): Promise<GenerateContentResponse>;
  /**
   * The raw SDK client, for what the pool does not cover — embeddings, file
   * uploads, anything that is not a chat completion. For a chat completion, use
   * `generate`.
   */
  ai: GoogleGenAI;
  /**
   * Null when the bot is not connected to Discord. Hooks always have one, since
   * they are triggered by Discord events, but a panel or tool can be reached
   * from the admin panel with the gateway down.
   */
  discordClient: Client | null;
  /** This plugin's saved configuration, as edited in the admin panel. */
  getConfig<T = Record<string, unknown>>(): T;
  /** Secrets for this plugin, stored encrypted and kept out of the config. */
  getEnv(): Record<string, string>;
  /** This plugin's own key/value store. No other plugin can reach these rows. */
  storage: PluginStorage;
  /**
   * This plugin's own SQLite database — its own file, its own tables, its own
   * migrations. Opened on first access. Create tables with
   * `CREATE TABLE IF NOT EXISTS` on startup; the bot does not manage the schema.
   *
   * **Never cache the handle.** Reloading closes every plugin database before
   * re-importing, so a copy kept at module scope is closed underneath you and
   * fails on the next call. Read it off the context each time.
   */
  readonly database: Database;
}

export interface OnMessageContext extends PluginContext {
  message: Message;
}

export interface OnHourlyCheckContext extends PluginContext {
  channelId: string;
  guildId: string;
  newMessages: Message[];
}

export interface OnBotTaggedContext extends PluginContext {
  message: Message;
}

/** Everything that will be handed to Gemini to write the reply. */
export interface DraftPrompt {
  systemInstruction: string;
  conversation: Content[];
  retrievedFacts: Fact[];
  sourceMessages: SourceMessage[];
}

export interface BeforeReplyContext extends PluginContext {
  taggedMessage: Message;
  draftPrompt: DraftPrompt;
}

export interface BeforeReplyResult {
  /** Replaces the draft the model will be given. */
  draftPrompt?: DraftPrompt;
  /** Aborts the reply entirely — use when a plugin has already responded itself. */
  skipReply?: boolean;
}

/** Someone the bot is about to talk to, or about. */
export interface ContextUser {
  id: string;
  /** Server nickname where set, otherwise the display name — what people call them. */
  displayName: string;
  username: string;
  /** They appear in the recent messages, rather than only being named in a recalled fact. */
  inConversation: boolean;
  /** They sent the message that mentioned the bot. */
  isTagger: boolean;
}

/** A message from the window the reply is being written against. */
export interface ContextMessageRef {
  id: string;
  authorId: string;
  content: string;
  createdAt: number;
}

/**
 * Everything in play as the reply prompt is assembled, handed over so a plugin
 * can say something about it. Deliberately reply-only: the periodic extraction
 * pass never calls this, so nothing a plugin contributes here can end up
 * embedded in a stored fact.
 */
export interface AnnotateContextContext extends PluginContext {
  taggedMessage: Message;
  /** Everyone in the message window, plus anyone mentioned in the recalled facts. */
  users: ContextUser[];
  messages: ContextMessageRef[];
  facts: Fact[];
}

/**
 * What a plugin adds to the assembled prompt. Keyed rather than free-form so
 * each line is rendered beside the thing it is about, and so two plugins
 * annotating the same person do not have to know about each other.
 */
export interface ContextAnnotations {
  /** A line about a person, keyed by user id. */
  users?: Record<string, string>;
  /** A line about a recalled fact, keyed by fact id. */
  facts?: Record<string, string>;
  /** A line about a message in the window, keyed by message id. */
  messages?: Record<string, string>;
  /** Anything belonging to none of the three. */
  notes?: string;
}

/**
 * What the periodic extraction pass is looking at, handed over so a plugin can
 * put background beside it.
 *
 * Separate from `annotateContext` on purpose, and not a rename of it. Everything
 * a plugin says through that hook is reply-only, so it can never be embedded in
 * a stored fact and come back months later as though the server had agreed it —
 * reputation is written against that guarantee. A plugin wanting to reach the
 * extraction pass has to opt in here, knowing what it is opting into: whatever
 * it contributes is read by the model that decides what gets remembered forever.
 *
 * One structural guard still holds regardless. A fact is dropped unless it cites
 * a message id from the window, so a fact invented purely out of plugin text
 * cannot be stored. What remains is a fact that cites a real message but is
 * coloured by what a plugin said, and that is the price of the hook.
 */
export interface AnnotateExtractionContext extends PluginContext {
  channelId: string;
  guildId: string;
  messages: ContextMessageRef[];
}

/**
 * Host-authenticated details about the Discord message that caused a tool call.
 *
 * These values come from the gateway message and the bot's controller store,
 * never from model-generated tool arguments. Plugins may therefore use them as
 * an authorization boundary for actions aimed at Discord.
 */
export interface PluginToolInvocation {
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly requesterId: string;
  readonly requesterIsController: boolean;
  readonly requestContent: string;
}

/** What a tool handler receives, including its authoritative invocation. */
export interface PluginToolContext extends PluginContext {
  readonly invocation: PluginToolInvocation;
}

/**
 * A capability a plugin lends the bot. The model decides when to call it; the
 * handler answers with JSON, which goes straight back into the conversation.
 * A handler has the full PluginToolContext, so a tool can read or write facts,
 * hit an external API, or anything else the bot itself could do.
 */
export interface PluginTool {
  /** Lowercase with underscores, unique across plugins. Prefixed with the plugin id when registered. */
  name: string;
  /** Written for the model: say plainly when it should reach for this. */
  description: string;
  /** JSON Schema for the arguments. Use an empty properties object for none. */
  parameters: Record<string, unknown>;
  /** Offered and executed only when the requesting Discord user is a bot controller. */
  requiresController?: boolean;
  /**
   * Lets `requiresController` stand down when this raw plugin config value is
   * exactly `true`, so the tool is offered to everyone and the plugin decides
   * for itself who may use it.
   *
   * Only reach for this when the plugin has a *better* test than controller
   * status — Discord Admin uses it to ask whether the requester holds the
   * Discord permission for the action themselves, which is a real authority the
   * host cannot see. Without a check of your own this is simply an off switch
   * for the controller gate, which is not what it is for.
   */
  controllerBypassConfig?: string;
  /** Offered and executed only when this raw plugin config value is exactly `true`. */
  enabledByConfig?: string;
  handler(args: Record<string, unknown>, ctx: PluginToolContext): Promise<unknown> | unknown;
}

/** One piece of a plugin's panel. Rendered by the admin app with its own components. */
export type PanelElement =
  | { type: 'text'; text: string; tone?: 'body' | 'muted' | 'success' | 'error' }
  | { type: 'heading'; text: string }
  | { type: 'status'; label: string; value: string; tone?: 'ok' | 'warn' | 'error' }
  /** `src` must be a data: URI or an https URL — a QR code, a captcha, a preview. */
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

/**
 * How a plugin describes one setting, so the admin panel can put the right
 * control in front of the operator instead of a JSON textarea. A plugin that
 * declares nothing keeps the textarea, so an older one stays configurable.
 */
export type PluginFieldType = 'string' | 'text' | 'number' | 'boolean' | 'select' | 'list';

export interface PluginField {
  /** Key in the config object. */
  name: string;
  label: string;
  type: PluginFieldType;
  /** Shown under the control. Say what the setting does, not what type it is. */
  description?: string;
  placeholder?: string;
  /** `number` only. */
  min?: number;
  max?: number;
  step?: number;
  /** `select` only, and the value written is one of these. */
  options?: Array<{ value: string; label: string }>;
  /** `list` only — what one entry is. Defaults to a string. */
  itemType?: 'string' | 'number';
  /** Refuses to save empty. A boolean is never required; it is always one or the other. */
  required?: boolean;
}

/**
 * A secret the plugin knows it needs. Declaring them means the panel can show
 * the operator what to fill in before anything goes wrong, rather than after.
 * A declared secret cannot be deleted — only emptied — since deleting it would
 * remove a row the plugin still expects; an undeclared one added by hand still
 * can be.
 */
export interface PluginSecretField {
  /** UPPER_SNAKE, matching what `getEnv()` returns. */
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  /** The plugin will not work without it, and the panel says so. */
  required?: boolean;
  /** Seeded on first install. Only for something that is not itself a secret, like a host name. */
  default?: string;
}

export interface PanelView {
  elements: PanelElement[];
  /**
   * Re-fetch the panel automatically every N seconds — for a QR code being
   * scanned. Clamped by the engine to 2–300; anything outside that is dropped.
   */
  pollSeconds?: number;
}

export interface PanelActionResult {
  message?: string;
  tone?: 'success' | 'error';
  /** Render this instead of re-running render(). */
  view?: PanelView;
}

/**
 * A plugin's own corner of the admin panel: a login form, a QR code to scan, a
 * connection status. Declarative rather than plugin-supplied markup, so nothing
 * a plugin returns can inject scripts into the panel.
 */
export interface PluginPanel {
  id: string;
  title: string;
  description?: string;
  render(ctx: PluginContext): Promise<PanelView> | PanelView;
  /** Invoked when someone presses one of the panel's buttons. */
  action?(
    actionId: string,
    values: Record<string, string>,
    ctx: PluginContext,
  ): Promise<PanelActionResult | void> | PanelActionResult | void;
}

/** What the panel asks a page for. `page` is 1-based. */
export interface PluginPageRequest {
  page: number;
  pageSize: number;
  /** What was typed in the search box, or '' when nothing was. */
  query: string;
}

/**
 * One cell. A `user` or `channel` carries the id, and the server turns it into a
 * name on the way out — a plugin holds ids because ids are what survives someone
 * renaming themselves, but an operator reading a table wants the name.
 */
export type PluginCell =
  | {
      kind: 'text';
      text: string;
      tone?: 'body' | 'muted' | 'success' | 'error';
      /**
       * A short stand-in shown in the table when `text` is long enough to make
       * a row unreadable — a paragraph-length memory, say. The panel renders
       * this in the cell and puts the full `text` behind a button that opens a
       * dialog. Both travel in the same payload, so opening one costs no
       * request, and mentions resolve in both.
       *
       * Leave it unset and the cell renders `text` as it always has.
       */
      preview?: string;
    }
  | { kind: 'user'; id: string }
  | { kind: 'channel'; id: string }
  | { kind: 'number'; value: number; suffix?: string }
  /** A 0–1 proportion, drawn as a bar. */
  | { kind: 'meter'; value: number; label?: string }
  /** Epoch millis, rendered as how long ago. */
  | { kind: 'time'; at: number }
  | { kind: 'badge'; text: string; tone?: 'ok' | 'warn' | 'error' };

export interface PluginPageColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  /** Dropped first when the screen is narrow. */
  secondary?: boolean;
}

export interface PluginPageRow {
  /** Passed back to `action` when a row button is pressed. */
  id: string;
  cells: Record<string, PluginCell>;
  actions?: Array<{ actionId: string; label: string; tone?: 'default' | 'destructive'; confirm?: string }>;
}

export interface PluginPageData {
  columns: PluginPageColumn[];
  rows: PluginPageRow[];
  /** Every row matching the query, not just this page — the pager needs it. */
  total: number;
  /** Rendered above the table: a summary line, a button, a divider. */
  header?: PanelElement[];
  searchable?: boolean;
  emptyMessage?: string;
}

/**
 * A screen of a plugin's own data — scores, memories, a log. Its own route in
 * the admin panel rather than a dialog, because this is the kind of thing an
 * operator reads and pages through rather than glances at.
 *
 * Paging is the plugin's job, not the panel's: it is the only one that knows
 * whether that means a LIMIT or slicing an array, and handing back everything so
 * the panel can slice it stops working exactly when it starts mattering.
 */
export interface PluginPage {
  id: string;
  title: string;
  description?: string;
  render(ctx: PluginContext, request: PluginPageRequest): Promise<PluginPageData> | PluginPageData;
  /**
   * Invoked for a button, on a row or in the header. `rowId` is the row's own id
   * for a row button and **empty for a header button**, which is how a page-wide
   * action — clear everything, export the lot — is told apart from one aimed at
   * a single row.
   */
  action?(
    actionId: string,
    rowId: string,
    ctx: PluginContext,
  ): Promise<PanelActionResult | void> | PanelActionResult | void;
}

export interface BigYahuPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  defaultConfig?: Record<string, unknown>;

  /**
   * Appended to the reply system prompt while the plugin is enabled — how to
   * use its tools, house rules, anything the bot should simply know.
   */
  instructions?: string | ((ctx: PluginContext) => string);

  /** Tools the model may call while writing a reply. */
  tools?: PluginTool[];

  /**
   * Small screens: a login form, a QR code, a connection status, a setup step.
   * Opened as a dialog. Anything the operator reads and pages through belongs in
   * `pages` instead.
   */
  panels?: PluginPanel[];

  /** Screens of the plugin's own data, each with its own route and a paginated table. */
  pages?: PluginPage[];

  /**
   * The plugin's settings, described so the panel can render real controls.
   * Declare them and the JSON textarea is replaced by a form; declare nothing
   * and the textarea stays, so an older plugin is still configurable.
   */
  configSchema?: PluginField[];

  /** The secrets this plugin needs. Declared ones can be emptied but not deleted. */
  secrets?: PluginSecretField[];

  /**
   * Called while the reply prompt is being built, before beforeReply. Return
   * annotations to merge into the prompt — scores, flags, anything the bot
   * should know about the people, messages or facts in front of it without
   * having to ask for it with a tool call.
   */
  annotateContext?(
    ctx: AnnotateContextContext,
  ): Promise<ContextAnnotations | void> | ContextAnnotations | void;

  /**
   * Called while the periodic fact-extraction prompt is being built. Return
   * background the model should have while it decides what is worth
   * remembering. Read the note on AnnotateExtractionContext before implementing
   * it: unlike annotateContext, what you say here reaches the pass that writes
   * permanent memory.
   */
  annotateExtraction?(ctx: AnnotateExtractionContext): Promise<string | void> | string | void;

  onMessage?(ctx: OnMessageContext): Promise<void> | void;
  onHourlyCheck?(ctx: OnHourlyCheckContext): Promise<void> | void;
  onBotTagged?(ctx: OnBotTaggedContext): Promise<void> | void;
  beforeReply?(ctx: BeforeReplyContext): Promise<BeforeReplyResult | void> | BeforeReplyResult | void;
}

export const HOOK_NAMES = [
  'onMessage',
  'onHourlyCheck',
  'onBotTagged',
  'annotateContext',
  'annotateExtraction',
  'beforeReply',
] as const;
export type HookName = (typeof HOOK_NAMES)[number];
