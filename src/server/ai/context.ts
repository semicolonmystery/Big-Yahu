import { ActivityType, MessageType } from 'discord.js';
import type { Message, TextBasedChannel } from 'discord.js';
import type { Part, Schema } from '@google/genai';
import { generate } from './generate';
import { searchFacts } from '../db/repositories/factsRepo';
import { getSettings } from '../db/repositories/settingsRepo';
import { MAX_ESCALATION_DEPTH_HARD_CAP } from '@shared/constants';
import type { Fact } from '@shared/types';
import type { ExtractionResult } from './schemas';
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

function describeAuthor(message: WindowMessage): string {
  // The bot's own lines are labelled "you" and nothing else. Seeing its own
  // nickname here made it talk about itself in the third person, as if some
  // other bot had said it.
  if (message.isSelf) return 'you';
  const handle = message.displayName === message.authorUsername ? '' : ` aka ${message.authorUsername}`;
  return `${message.displayName}${handle} <@${message.authorId}>`;
}

/**
 * Two conversations running at once in one channel are only tellable apart by
 * what replies to what, so every reply says which message it answers. The id is
 * given even when that message is outside the window: knowing a line belongs to
 * a thread you cannot see beats reading it as part of the one you can.
 */
function describeReplyTo(message: WindowMessage): string {
  if (!message.replyToId) return '';
  const author = message.replyToAuthorId ? ` by <@${message.replyToAuthorId}>` : '';
  return ` [replying to id=${message.replyToId}${author}]`;
}

/**
 * Says "not shown" rather than just "[image]". A bare marker reads as something
 * the model has and invites it to describe the contents; the point is the
 * opposite — the message had a picture, it is not blank, and you cannot see it.
 */
function describeUnseenImages(message: WindowMessage): string {
  const count = message.unseenImages ?? 0;
  if (count <= 0) return '';
  return count === 1 ? ' [image not shown]' : ` [${count} images not shown]`;
}

export function formatTranscript(messages: WindowMessage[]): string {
  return messages
    .map(
      (message) =>
        `[id=${message.id}]${describeReplyTo(message)} [${new Date(message.createdAt).toISOString()}] `
        + `${describeAuthor(message)}: ${message.content}${describeUnseenImages(message)}`,
    )
    .join('\n');
}

/** Folds the unseen-picture counts into the window before it is written out. */
export function markUnseenImages(messages: WindowMessage[], unseen: Map<string, number>): WindowMessage[] {
  if (unseen.size === 0) return messages;
  return messages.map((message) =>
    unseen.has(message.id) ? { ...message, unseenImages: unseen.get(message.id) } : message,
  );
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

/** Who the bot is in this server right now, so it recognises its own name. */
export function describeSelf(message: Message): string {
  const client = message.client.user;
  if (!client) return '';
  const nickname = message.guild?.members.me?.displayName;
  const names = [...new Set([nickname, client.displayName, client.username].filter(Boolean))];
  return (
    `You are <@${client.id}>. In this server you show up as "${names[0] ?? client.username}"`
    + (names.length > 1 ? ` (also known as ${names.slice(1).map((name) => `"${name}"`).join(', ')})` : '')
    + '. When people use that name, or reply to a message marked "you", they mean you.'
  );
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
export function describeActivities(
  message: Message,
  people: Array<{ id: string; displayName: string }>,
): string {
  const guild = message.guild;
  if (!guild) return '';

  const lines: string[] = [];
  const seen = new Set<string>();

  for (const person of people) {
    if (seen.has(person.id)) continue;
    seen.add(person.id);

    const presence = guild.presences.cache.get(person.id);
    if (!presence) {
      lines.push(`${person.displayName} <@${person.id}> — offline, or hiding it`);
      continue;
    }

    const doing = (presence.activities ?? []).map(describeActivity).filter(Boolean).join('; ');
    lines.push(
      `${person.displayName} <@${person.id}> — ${presence.status}`
      + (doing ? `, ${doing}` : ', not doing anything Discord can see'),
    );
  }

  return lines.join('\n');
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
export function listGuildPeople(message: Message, nameContains?: string): string {
  const guild = message.guild;
  if (!guild) return 'Not in a guild, so there is nobody to list.';

  const selfId = message.client.user?.id;
  const lines = new Map<string, string>();

  for (const [id, presence] of guild.presences.cache) {
    if (id === selfId) continue;
    const member = presence.member;
    const name = member?.displayName ?? presence.user?.username ?? id;
    const handle = presence.user?.username;
    const doing = (presence.activities ?? []).map(describeActivity).filter(Boolean).join('; ');
    lines.set(
      id,
      `${name}${handle && handle !== name ? ` aka ${handle}` : ''} <@${id}> — ${presence.status}`
      + (doing ? `, ${doing}` : ', not doing anything Discord can see'),
    );
  }

  for (const [id, member] of guild.members.cache) {
    if (id === selfId || lines.has(id)) continue;
    const handle = member.user.username;
    const name = member.displayName;
    lines.set(id, `${name}${handle !== name ? ` aka ${handle}` : ''} <@${id}> — offline, or hiding it`);
  }

  const needle = nameContains?.trim().toLowerCase();
  let listed = [...lines.values()];
  if (needle) listed = listed.filter((line) => line.toLowerCase().includes(needle));

  if (listed.length === 0) {
    return needle
      ? `Nobody visible matches "${nameContains}". They may be offline, or not in this server at all.`
      : 'Nobody is visible right now.';
  }

  const capped = listed.slice(0, PEOPLE_LISTING_CAP);
  return (
    `${capped.join('\n')}\n\n`
    + `This is everyone currently visible${listed.length > capped.length ? ` (${capped.length} of ${listed.length} shown)` : ''}. `
    + 'It is not the full member list — people who are offline and have not spoken lately do not appear, '
    + 'so somebody missing here is not proof they are not in the server.'
  );
}

export function formatFacts(facts: Fact[]): string {
  return facts
    .map((fact) => `[factId=${fact.id}] [channelId=${fact.metadata.channelId}] ${fact.text}`)
    .join('\n');
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

export interface EscalationOptions {
  schema: Schema;
  systemInstruction: string;
  /** What the model is being asked to do with this window. */
  task: string;
  windowMessages: WindowMessage[];
  /** Anchor used to walk further back, through its own channel. */
  anchorMessage: Message;
  guildId: string;
  /** Pictures from the window, attached after the text. */
  imageParts?: Part[];
  attachmentBudget?: TextAttachmentBudget;
}

function parseResponse<T>(raw: string | undefined): T {
  if (!raw) throw new Error('Gemini returned an empty response');
  return JSON.parse(raw) as T;
}

/**
 * Runs a structured extraction, and if the model says it cannot understand the
 * window without earlier conversation, widens the window with older messages
 * plus related stored facts and asks again. Bounded so it can never spin.
 */
export async function runEscalatableExtraction<T extends ExtractionResult>(
  options: EscalationOptions,
): Promise<T> {
  const settings = getSettings();
  const maxDepth = effectiveMaxDepth();

  let olderMessages: WindowMessage[] = [];
  let relatedFacts: Fact[] = [];

  for (let depth = 0; ; depth += 1) {
    const isFinalAttempt = depth >= maxDepth;

    const sections = [options.task];
    if (relatedFacts.length > 0) {
      sections.push(`Facts already known about this server:\n${formatFacts(relatedFacts)}`);
    }
    if (olderMessages.length > 0) {
      sections.push(`Earlier messages, for background:\n${formatTranscript(olderMessages)}`);
    }
    sections.push(`Messages to work from:\n${formatTranscript(options.windowMessages)}`);
    if (isFinalAttempt) {
      sections.push('No further context is available. Give your best answer using only what is above.');
    }

    const prompt = sections.join('\n\n');
    const imageParts = options.imageParts ?? [];
    const response = await generate(
      imageParts.length > 0 ? [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }] : prompt,
      {
        systemInstruction: options.systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: options.schema,
      },
    );

    const result = parseResponse<T>(response.text);
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

    const hint = result.contextHint?.trim() || result.facts.map((fact) => fact.text).join(' ');
    if (hint) {
      relatedFacts = (await searchFacts(hint, settings.factSearchTopK, { guildId: options.guildId }))
        .filter((fact) => canExtractFrom(fact.metadata.channelId));
    }
  }
}
