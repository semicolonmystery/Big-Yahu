import type { WindowMessage } from './context';
import type { Fact, SourceMessage } from '@shared/types';

/**
 * What the model is given to work from, as data rather than prose.
 *
 * Everything that changes between calls lives here, in one JSON document, while
 * the prompts hold only the rules. Two things come of that: the rules are
 * identical from call to call, so the provider can cache them, and the material
 * cannot be impersonated — message text is a JSON string, so somebody typing
 * `[id=123] you:` into Discord is quoted text, not a line of the transcript.
 */

/** What the bot is called in its own transcript, in place of an id. */
const SELF = 'you';

/** One message, as the model reads it. */
export interface MaterialMessage {
  id: string;
  /** When it was sent, ISO 8601. */
  at: string;
  /**
   * Who sent it — the literal string `you` on the bot's own lines, never its id.
   *
   * Authorship has to sit in the same field, on every message, or it is not
   * read. A flag alongside a real id is something a model skims past, and then
   * it discusses its own messages as if somebody else had said them: it did
   * exactly that, attributing its own line to the person it was talking to.
   */
  authorId: string;
  /** The message this one answers, when it answers one. `you` again, where that is who it was. */
  replyTo?: { id: string; authorId?: string };
  /** Discord's own markup is kept: `<@id>` and `<#id>`, annotated with the name. */
  content: string;
  /** Pictures on this message that were not sent to the model. */
  unseenImages?: number;
  /** Background from the bot's plugins about this message. */
  notes?: string[];
}

export function messageMaterial(message: WindowMessage, notes?: string[]): MaterialMessage {
  return {
    id: message.id,
    at: new Date(message.createdAt).toISOString(),
    authorId: message.isSelf ? SELF : message.authorId,
    ...(message.replyToId
      ? {
        replyTo: {
          id: message.replyToId,
          ...(message.replyToIsSelf ? { authorId: SELF } : {}),
          ...(!message.replyToIsSelf && message.replyToAuthorId ? { authorId: message.replyToAuthorId } : {}),
        },
      }
      : {}),
    content: message.content,
    ...(message.unseenImages ? { unseenImages: message.unseenImages } : {}),
    ...(notes?.length ? { notes } : {}),
  };
}

export function messagesMaterial(messages: WindowMessage[], notes?: Map<string, string[]>): MaterialMessage[] {
  return messages.map((message) => messageMaterial(message, notes?.get(message.id)));
}

/** A message a stored fact was drawn from, so the model can quote and link it. */
export interface MaterialSource {
  id: string;
  channelId: string;
  authorId: string;
  authorUsername: string;
  content: string;
}

export interface MaterialFact {
  id: string;
  channelId: string;
  text: string;
  /** What kinds of thing it is. Absent means nobody has sorted it yet. */
  types?: string[];
  /** Which of the searches turned it up, so a rule hit is not read as something somebody said. */
  foundBy?: string[];
  /** The messages it came from, where they are still cached. */
  sources?: MaterialSource[];
  notes?: string[];
}

export function factsMaterial(
  facts: Array<Fact & { foundBy?: string[] }>,
  sourceMessages: SourceMessage[] = [],
  notes?: Map<string, string[]>,
): MaterialFact[] {
  const byId = new Map(sourceMessages.map((message) => [message.messageId, message]));
  return facts.map((fact) => {
    const sources = fact.metadata.messageIds
      .map((id) => byId.get(id))
      .filter((message): message is SourceMessage => message !== undefined)
      .map((message) => ({
        id: message.messageId,
        channelId: message.channelId,
        authorId: message.authorId,
        authorUsername: message.authorUsername,
        content: message.content,
      }));
    const factNotes = notes?.get(fact.id);
    return {
      id: fact.id,
      channelId: fact.metadata.channelId,
      text: fact.text,
      ...(fact.metadata.types?.length ? { types: fact.metadata.types } : {}),
      ...(fact.foundBy?.length ? { foundBy: fact.foundBy } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(factNotes?.length ? { notes: factNotes } : {}),
    };
  });
}

/** Someone the bot is talking to, or about. */
export interface MaterialPerson {
  id: string;
  name: string;
  /** Only when it differs from the name people call them. */
  username?: string;
  /** They spoke in the messages below, rather than only being named in one. */
  spokeHere?: true;
  /** They are the one who tagged the bot. */
  isAsking?: true;
  /** Straight from Discord, and live. */
  status?: string;
  doing?: string;
  notes?: string[];
}

export function peopleMaterial(
  users: Array<{ id: string; displayName: string; username: string; inConversation: boolean; isTagger: boolean }>,
  presence: Map<string, { status: string; doing?: string }> = new Map(),
  notes?: Map<string, string[]>,
): MaterialPerson[] {
  return users.map((user) => {
    const seen = presence.get(user.id);
    const personNotes = notes?.get(user.id);
    return {
      id: user.id,
      name: user.displayName,
      ...(user.username && user.username !== user.displayName ? { username: user.username } : {}),
      ...(user.inConversation ? { spokeHere: true as const } : {}),
      ...(user.isTagger ? { isAsking: true as const } : {}),
      ...(seen ? { status: seen.status, ...(seen.doing ? { doing: seen.doing } : {}) } : {}),
      ...(personNotes?.length ? { notes: personNotes } : {}),
    };
  });
}

/**
 * Compact rather than indented: the model reads either just as well, and every
 * space in here is a token on a document sent with each call.
 */
export function renderMaterial(material: Record<string, unknown>): string {
  return JSON.stringify(material);
}
