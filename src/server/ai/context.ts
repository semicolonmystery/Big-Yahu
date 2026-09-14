import { ActivityType, MessageType } from 'discord.js';
import type { Guild, Message, TextBasedChannel } from 'discord.js';
import { structured, UnreadableAnswerError } from './structured';
import { factsMaterial, messagesMaterial, renderMaterial } from './material';
import type { JsonSchema } from './jsonSchema';
import { searchFacts } from '../db/repositories/factsRepo';
import { getSettings } from '../db/repositories/settingsRepo';
import { HOST_FAILURE_NOTICE, MAX_ESCALATION_DEPTH_HARD_CAP, formatNow } from '@shared/constants';
import type { Fact } from '@shared/types';
import type { MessageImage } from '../bot/attachments';
import { readTextAttachments, type TextAttachmentBudget } from '../bot/textAttachments';
import { canExtractFrom } from '../db/repositories/channelSettingsRepo';

export interface WindowMessage {
  id: string;
  authorId: string;
  authorUsername: string;
  /** Server nickname where set, otherwise the display name — what people actually call them. */
  displayName: string;
  content: string;
  createdAt: number;
  isSelf: boolean;
  /** Pictures on this message the model was not given, so the line is not read as empty. */
  unseenImages?: number;
  /** The message this one is a reply to, when it is one. */
  replyToId?: string;
  /** Who wrote that message, where Discord told us — it may sit outside the window. */
  replyToAuthorId?: string;
  /** The message it answers is one of the bot's own. */
  replyToIsSelf?: boolean;
}

/**
 * Mention markup is left exactly as Discord wrote it, with the name added
 * beside it. Rewriting `<@id>` to a bare `@Name` taught the model that a
 * mention is plain text, so it produced names that pinged nobody; keeping the
 * real form means every example it reads is one it can copy.
 */
function annotateMentions(message: Message): string {
  let content = message.content;
  for (const [id, user] of message.mentions.users) {
    const member = message.mentions.members?.get(id);
    const name = member?.displayName ?? user.displayName ?? user.username;
    for (const form of [`<@${id}>`, `<@!${id}>`]) {
      content = content.replaceAll(form, `<@${id}>(${name})`);
    }
  }
  for (const [id, channel] of message.mentions.channels) {
    const name = 'name' in channel ? channel.name : id;
    content = content.replaceAll(`<#${id}>`, `<#${id}>(#${name})`);
  }
  return content;
}

export function toWindowMessage(message: Message): WindowMessage {
  const author = message.author;
  // MessageType.Reply is the only kind that means "this answers that". A
  // forward or a pin notification also carries a reference, and treating those
  // as replies would invent a conversation that never happened.
  const replyTo = message.type === MessageType.Reply ? message.reference?.messageId : undefined;

  return {
    id: message.id,
    authorId: author.id,
    authorUsername: author.username,
    displayName: message.member?.displayName ?? author.displayName ?? author.username,
    content: annotateMentions(message),
    createdAt: message.createdTimestamp,
    isSelf: author.id === message.client.user?.id,
    replyToId: replyTo,
    replyToAuthorId: replyTo ? message.mentions.repliedUser?.id : undefined,
    replyToIsSelf: Boolean(replyTo && message.mentions.repliedUser?.id === message.client.user?.id),
  };
}

export async function windowMessagesWithAttachments(messages: Message[], budget?: TextAttachmentBudget): Promise<WindowMessage[]> {
  const attachments = await readTextAttachments(messages, budget);
  return messages.map((message) => {
    const window = toWindowMessage(message);
    const text = attachments.get(message.id);
    return text ? { ...window, content: `${window.content}\n${text}`.trim() } : window;
  });
}

/** Folds the unseen-picture counts into the window before it is written out. */
export function markUnseenImages(messages: WindowMessage[], unseen: Map<string, number>): WindowMessage[] {
  if (unseen.size === 0) return messages;
  return messages.map((message) =>
    unseen.has(message.id) ? { ...message, unseenImages: unseen.get(message.id) } : message,
  );
}

/**
 * Rewrites the bot's own canned failure messages into one fixed notice.
 *
 * These are not things it decided to say — they are what the host sends when no
 * model could be reached at all. Read back as its own words they are actively
 * misleading: after a spell out of credit the window was almost entirely "I have
 * run out of credit", and it began explaining that line to people as though it
 * had meant it, and then arguing about who had said it.
 *
 * They are replaced rather than dropped, because people in the channel saw them
 * and answer them; a gap where one was leaves those replies answering nothing.
 * The replacement is always the same sentence, and the prompt says what it means,
 * so the bot knows why it is looking at it.
 *
 * Matched on the text, because that is what is recoverable from Discord. An
 * operator who rewrites one of these afterwards simply gets the old ones back as
 * themselves, which is the harmless direction to be wrong in.
 */
export function markHostFailures(messages: WindowMessage[]): WindowMessage[] {
  const settings = getSettings();
  const canned = new Set([
    settings.rateLimitMessage, settings.overloadMessage,
    settings.busyMessage, settings.errorMessage, settings.noCreditsMessage,
  ].map((text) => text?.trim() ?? '').filter((text) => text.length > 0));
  if (canned.size === 0) return messages;
  return messages.map((message) => (message.isSelf && canned.has(message.content.trim())
    ? { ...message, content: HOST_FAILURE_NOTICE }
    : message));
}

/** Display name to user id, so a name the model writes can be turned into a real ping. */
export function mentionRoster(messages: WindowMessage[]): Map<string, string> {
  const roster = new Map<string, string>();
  for (const message of messages) {
    if (message.isSelf) continue;
    roster.set(message.displayName, message.authorId);
    roster.set(message.authorUsername, message.authorId);
  }
  return roster;
}

/**
 * Who the bot is in this server right now, so it recognises its own name. The
 * server nickname comes first: it is what people actually type at it.
 */
export function selfMaterial(message: Message): { id: string; names: string[] } | undefined {
  const client = message.client.user;
  if (!client) return undefined;
  const nickname = message.guild?.members.me?.displayName;
  const names = [...new Set([nickname, client.displayName, client.username].filter((name): name is string => Boolean(name)))];
  return { id: client.id, names };
}

const ACTIVITY_VERB: Record<number, string> = {
  [ActivityType.Playing]: 'playing',
  [ActivityType.Streaming]: 'streaming',
  [ActivityType.Listening]: 'listening to',
  [ActivityType.Watching]: 'watching',
  [ActivityType.Competing]: 'competing in',
};

function describeActivity(activity: { type: number; name: string; details: string | null; state: string | null }): string {
  // A custom status is a line of text the person wrote, not something they are doing.
  if (activity.type === ActivityType.Custom) {
    return activity.state ? `status "${activity.state}"` : '';
  }
  const detail = [activity.details, activity.state].filter(Boolean).join(' — ');
  const verb = ACTIVITY_VERB[activity.type] ?? 'doing';
  return detail ? `${verb} ${activity.name} (${detail})` : `${verb} ${activity.name}`;
}

/**
 * What Discord says each person is doing right now.
 *
 * Presence is read from `guild.presences`, never through `members.cache`. A
 * GuildMember's `presence` is only a lookup into that same presence cache, but
 * going via the member cache meant anyone who had not spoken recently was
 * skipped — the member was not cached, so their presence was never read even
 * though it was sitting there. Without the GuildMembers intent that cache is
 * sparse, which is most people most of the time.
 *
 * Someone with no presence is reported as offline rather than left out. Silence
 * reads to the model as missing data and invites a guess; "offline" is an answer.
 */
export function presenceFor(message: Message, ids: string[]): Map<string, { status: string; doing?: string }> {
  const guild = message.guild;
  const found = new Map<string, { status: string; doing?: string }>();
  if (!guild) return found;

  for (const id of new Set(ids)) {
    const presence = guild.presences.cache.get(id);
    if (!presence) {
      // Said outright rather than left out: silence reads as missing data and
      // invites a guess, while "offline" is an answer.
      found.set(id, { status: 'offline, or hiding it' });
      continue;
    }
    const doing = (presence.activities ?? []).map(describeActivity).filter(Boolean).join('; ');
    found.set(id, { status: presence.status, ...(doing ? { doing } : {}) });
  }
  return found;
}

/** Nobody needs a thousand names in a prompt; the useful ones are near the top anyway. */
const PEOPLE_LISTING_CAP = 150;

/**
 * Everyone in the guild the bot can actually see, for when it is asked about
 * somebody who has not spoken in the window.
 *
 * The presence cache is the good source here: with the Presences intent it
 * holds everyone currently online, which is precisely the set anyone asks
 * "what is X playing" about. The member cache is folded in for people seen
 * recently but now offline. A complete roster would need the privileged
 * GuildMembers intent, so the listing says plainly that it is partial rather
 * than letting the model read absence as proof somebody is not in the server.
 */
export interface GuildPerson {
  id: string;
  name: string;
  username?: string;
  status: string;
  doing?: string;
}

/**
 * Everyone the bot can currently see in a guild, presences first and the member
 * cache behind them.
 *
 * Takes a `Guild` rather than a `Message` so the admin panel can ask too — the
 * controllers list needs names, and it has no Discord message in hand.
 */
export function guildPeople(guild: Guild, selfId?: string, nameContains?: string): GuildPerson[] {
  const found = new Map<string, GuildPerson>();

  for (const [id, presence] of guild.presences.cache) {
    if (id === selfId) continue;
    const member = presence.member;
    const name = member?.displayName ?? presence.user?.username ?? id;
    const username = presence.user?.username;
    const doing = (presence.activities ?? []).map(describeActivity).filter(Boolean).join('; ');
    found.set(id, {
      id, name, ...(username && username !== name ? { username } : {}),
      status: presence.status, ...(doing ? { doing } : {}),
    });
  }

  for (const [id, member] of guild.members.cache) {
    if (id === selfId || found.has(id)) continue;
    const username = member.user.username;
    const name = member.displayName;
    found.set(id, {
      id, name, ...(username !== name ? { username } : {}), status: 'offline, or hiding it',
    });
  }

  const needle = nameContains?.trim().toLowerCase();
  const listed = [...found.values()];
  return needle
    ? listed.filter((person) => `${person.name} ${person.username ?? ''}`.toLowerCase().includes(needle))
    : listed;
}

export function listGuildPeople(message: Message, nameContains?: string): {
  people: GuildPerson[];
  visibleOnly: true;
  matching?: string;
  shown?: number;
  total?: number;
} {
  const guild = message.guild;
  if (!guild) return { people: [], visibleOnly: true };

  const listed = guildPeople(guild, message.client.user?.id, nameContains);
  const capped = listed.slice(0, PEOPLE_LISTING_CAP);
  return {
    people: capped,
    // Never the full member list: whoever is offline and has not spoken lately
    // is absent, so somebody missing is not proof they left.
    visibleOnly: true,
    ...(nameContains?.trim() ? { matching: nameContains.trim() } : {}),
    ...(listed.length > capped.length ? { shown: capped.length, total: listed.length } : {}),
  };
}

/** Discord's per-call maximum. */
const FETCH_LIMIT = 100;

/** Everything text-based can be read except a partial group DM, which has no message manager. */
function isReadable(channel: TextBasedChannel): boolean {
  return 'messages' in channel;
}

/**
 * Discord returns newest-first; conversations read oldest-first. Bot chatter is
 * left out of history.
 *
 * Takes the channel rather than a message in it, so the same walk works for a
 * channel the bot was only pointed at.
 */
export async function fetchOlderMessages(
  channel: TextBasedChannel,
  beforeMessageId: string,
  notOlderThan: number,
  attachmentBudget?: TextAttachmentBudget,
): Promise<WindowMessage[]> {
  if (!isReadable(channel)) return [];
  const batch = await channel.messages.fetch({ before: beforeMessageId, limit: FETCH_LIMIT });
  const messages = [...batch.values()]
    .filter((older) => !older.author.bot && older.createdTimestamp >= notOlderThan)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return windowMessagesWithAttachments(messages, attachmentBudget);
}

/**
 * The tail of a channel, for one the bot has no anchor message in. Bots are left
 * out for the same reason as above: the bot reading its own chatter back is not
 * history, it is an echo.
 */
export async function fetchRecentMessages(channel: TextBasedChannel, limit: number, attachmentBudget?: TextAttachmentBudget): Promise<WindowMessage[]> {
  if (!isReadable(channel) || limit <= 0) return [];
  const batch = await channel.messages.fetch({ limit: Math.min(limit, FETCH_LIMIT) });
  const messages = [...batch.values()].filter((message) => !message.author.bot)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return windowMessagesWithAttachments(messages, attachmentBudget);
}

export function effectiveMaxDepth(): number {
  return Math.min(getSettings().maxEscalationDepth, MAX_ESCALATION_DEPTH_HARD_CAP);
}

/** What every escalatable answer carries, whatever else it holds. */
export interface EscalatableResult {
  needsMoreContext: boolean;
  contextHint: string;
}

export interface EscalationOptions<T extends EscalatableResult> {
  /** Which AI task's model list answers, such as `factExtraction`. */
  aiTask: string;
  schema: JsonSchema;
  systemInstruction: string;
  /** What the model is being asked to do with this window. */
  task: string;
  windowMessages: WindowMessage[];
  /** Anchor used to walk further back, through its own channel. */
  anchorMessage: Message;
  guildId: string;
  /** Pictures from the window, attached after the material. */
  images?: MessageImage[];
  /** Extra fields for the material, such as which message each picture came from. */
  material?: Record<string, unknown>;
  attachmentBudget?: TextAttachmentBudget;
  /** What to search older facts for when the answer asked for more context but gave no hint. */
  hint?: (result: T) => string;
}

/**
 * Extraction answers a schema over a whole page of messages, so it needs far
 * more room than a chat reply. What cut answers off mid-document before was a
 * budget far smaller than a full page's worth of facts.
 */
const EXTRACTION_MAX_OUTPUT_TOKENS = 32_768;

/**
 * How many times a structured answer that could not be read is asked for again
 * on a narrower window. Each retry drops the oldest half of the messages, so a
 * page that cannot be answered whole still yields its most recent part instead
 * of being lost entirely.
 */
const UNREADABLE_ANSWER_RETRIES = 2;

/**
 * Runs a structured extraction, and if the model says it cannot understand the
 * window without earlier conversation, widens the window with older messages
 * plus related stored facts and asks again. Bounded so it can never spin.
 */
export async function runEscalatableExtraction<T extends EscalatableResult>(
  options: EscalationOptions<T>,
): Promise<T> {
  const settings = getSettings();
  const maxDepth = effectiveMaxDepth();

  let olderMessages: WindowMessage[] = [];
  let relatedFacts: Fact[] = [];

  for (let depth = 0; ; depth += 1) {
    const isFinalAttempt = depth >= maxDepth;

    const buildPrompt = (windowMessages: WindowMessage[]): string => renderMaterial({
      now: formatNow(settings.timezone),
      task: options.task,
      ...options.material,
      ...(relatedFacts.length > 0 ? { knownFacts: factsMaterial(relatedFacts) } : {}),
      ...(olderMessages.length > 0 ? { earlierMessages: messagesMaterial(olderMessages) } : {}),
      messages: messagesMaterial(windowMessages),
      // Nothing more can be fetched, so the answer has to be made from what is here.
      ...(isFinalAttempt ? { noFurtherContext: true } : {}),
    });

    const ask = (windowMessages: WindowMessage[]): Promise<T> => structured<T>(options.aiTask, {
      system: options.systemInstruction,
      user: buildPrompt(windowMessages),
      images: options.images,
      schema: options.schema,
      maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    });

    // A page that cannot be answered whole is worth asking about in part. Only
    // the oldest messages are dropped, so what survives is the most recent and
    // the escalation state above is untouched.
    const askNarrowing = async (): Promise<T> => {
      let window = options.windowMessages;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await ask(window);
        } catch (error) {
          if (!(error instanceof UnreadableAnswerError)) throw error;
          if (attempt >= UNREADABLE_ANSWER_RETRIES || window.length <= 1) throw error;
          const kept = window.slice(Math.ceil(window.length / 2));
          console.warn(
            `[ai] ${error.truncated ? 'truncated' : 'unreadable'} answer (${error.message}) — `
              + `retrying on the newest ${kept.length} of ${window.length} messages`,
          );
          window = kept;
        }
      }
    };

    const result = await askNarrowing();
    if (!result.needsMoreContext || isFinalAttempt) return result;

    const earliest = olderMessages[0] ?? options.windowMessages[0] ?? toWindowMessage(options.anchorMessage);
    const lookbackMs = settings.escalationLookbackHours * 60 * 60 * 1000;
    const fetched = await fetchOlderMessages(
      options.anchorMessage.channel,
      earliest.id,
      earliest.createdAt - lookbackMs,
      options.attachmentBudget,
    );
    olderMessages = [...fetched, ...olderMessages];

    const hint = result.contextHint.trim() || options.hint?.(result).trim() || '';
    if (hint) {
      relatedFacts = (await searchFacts(hint, settings.factSearchTopK, { guildId: options.guildId }))
        .filter((fact) => canExtractFrom(fact.metadata.channelId));
    }
  }
}
