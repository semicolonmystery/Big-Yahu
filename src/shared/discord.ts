export function buildJumpLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

const JUMP_LINK_PATTERN = /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;

const LINK_MARKER = /<link:(\d+)>/g;

/**
 * Turns `<link:messageId>` into a real jump link.
 *
 * The model is never given the server id, and never needs it: it names the
 * message it means and the bot builds the URL, which is the only way a link
 * cannot come out pointing at the wrong server or at a message that does not
 * exist. A marker naming a message it was not shown is dropped, exactly as an
 * invented URL would be.
 */
export function expandLinkMarkers(
  text: string,
  guildId: string,
  channelOf: (messageId: string) => string | undefined,
): string {
  return text.replace(LINK_MARKER, (_match, messageId: string) => {
    const channelId = channelOf(messageId);
    return channelId ? buildJumpLink(guildId, channelId, messageId) : '';
  });
}

/**
 * Removes jump links pointing at message IDs the model was never shown, so a
 * hallucinated ID cannot reach Discord as a dead link.
 */
export function stripUnknownJumpLinks(text: string, knownMessageIds: Set<string>): string {
  return text.replace(JUMP_LINK_PATTERN, (match, _guildId, _channelId, messageId: string) =>
    knownMessageIds.has(messageId) ? match : '',
  );
}

const CHANNEL_MENTION = /<#(\d+)>/g;
const USER_MENTION = /<@!?(\d+)>/g;

/**
 * Drops <#channel> and <@user> mentions the model was never given. Discord
 * renders an unknown channel as "#unknown" and an unknown user as a raw ID,
 * both of which read as the bot confidently pointing at nothing.
 */
export function stripUnknownMentions(
  text: string,
  isKnownChannel: (id: string) => boolean,
  isKnownUser: (id: string) => boolean,
): string {
  return text
    .replace(CHANNEL_MENTION, (match, id: string) => (isKnownChannel(id) ? match : ''))
    .replace(USER_MENTION, (match, id: string) => (isKnownUser(id) ? match : ''))
    .replace(/ {2,}/g, ' ');
}

/**
 * Bracket notation that has no business in a Discord message. The material is
 * JSON now, so nothing shown to the model is written this way any more, but a
 * model asked about a message id will still reach for `[replying to id=...]`
 * of its own accord, which reads as the bot leaking its own plumbing.
 *
 * Told not to, it mostly does not. Told not to is not a guarantee, and this is
 * the same argument as stripping invented jump links: the prompt asks, the
 * sanitiser enforces.
 */
const PROMPT_MARKERS = [
  /\[replying to id=\d+(?:\s+by\s*<@!?\d+>)?\]/gi,
  /\[(?:id|messageId|channelId|guildId)=\d+\]/gi,
  /\[factId=[\w-]+\]/gi,
  /\[memory=\d+\]/gi,
  /\[score [\d.]+\]/gi,
  /\[last touched [^\]]*\]/gi,
  /\[\d*\s*images? not shown\]/gi,
];

export function stripPromptMarkers(text: string): string {
  let result = text;
  for (const marker of PROMPT_MARKERS) result = result.replace(marker, '');
  return result.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
}

/**
 * Turns a plain-text `@Name` the model wrote into a real `<@id>` mention.
 * Discord only notifies someone when the id form is used, so a name on its own
 * is dead text. Longest names first, or "@Bob" would match inside "@Bobby".
 */
export function restoreMentions(text: string, roster: Map<string, string>): string {
  const names = [...roster.keys()].filter((name) => name.length > 0).sort((a, b) => b.length - a.length);
  return outsideQuotedSpans(text, (segment) => {
    let result = segment;
    for (const name of names) {
      const id = roster.get(name);
      if (!id) continue;
      // A handle must stand on its own. A prefix of an unknown username, an
      // email address or a URL must never turn into a notification for somebody.
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_@<./+-])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_]|[.-][\\p{L}\\p{N}_])`,
        'gu',
      );
      result = result.replace(pattern, `<@${id}>`);
    }
    return result.replace(/<@(\d+|[\w-]+)>\((?:#)?[^)]*\)/g, '<@$1>');
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Quoted runs are left alone, so a fact about someone's nickname keeps the nickname. */
const QUOTED_SPAN = /"[^"]*"|“[^”]*”|`[^`]*`/g;

function outsideQuotedSpans(text: string, rewrite: (segment: string) => string): string {
  let result = '';
  let cursor = 0;
  for (const quoted of text.matchAll(QUOTED_SPAN)) {
    result += rewrite(text.slice(cursor, quoted.index)) + quoted[0];
    cursor = quoted.index + quoted[0].length;
  }
  return result + rewrite(text.slice(cursor));
}

/** Names shorter than this are too easy to hit inside an ordinary word. */
const MIN_MENTIONABLE_NAME = 3;

/**
 * Rewrites people's names in a stored fact into `<@id>` mentions, so a fact
 * survives someone renaming themselves. Names inside quotes are deliberately
 * untouched: that is how a fact says the name itself is the point — a nickname
 * joke, a handle someone is teased for.
 */
export function mentionifyNames(text: string, roster: Map<string, string>): string {
  const names = [...roster.keys()]
    .filter((name) => name.trim().length >= MIN_MENTIONABLE_NAME && !/^\d+$/.test(name))
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;

  const replaceOutsideQuotes = (segment: string): string => {
    let result = segment;
    for (const name of names) {
      const id = roster.get(name);
      if (!id) continue;
      // Never match inside an existing `<@id>`, straight after an `@`, or in the
      // middle of a longer word — "Bob" must not fire inside "Bobby".
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_@<])${escapeRegExp(name)}(?![\\p{L}\\p{N}_>])`,
        'gu',
      );
      result = result.replace(pattern, `<@${id}>`);
    }
    return result;
  };

  // Names that contain quotes of their own — the `First "Nickname" Last` style
  // people set as a display name — are matched whole first. Left to the pass
  // below they would be split down the middle by their own quotes, and the
  // halves outside the quotes would survive as plain text.
  let working = text;
  for (const name of names.filter((candidate) => /["“`]/.test(candidate))) {
    working = working.split(name).join(`<@${roster.get(name)}>`);
  }

  let out = '';
  let cursor = 0;
  for (const quoted of working.matchAll(QUOTED_SPAN)) {
    out += replaceOutsideQuotes(working.slice(cursor, quoted.index)) + quoted[0];
    cursor = quoted.index + quoted[0].length;
  }
  return collapseRepeatedMentions(out + replaceOutsideQuotes(working.slice(cursor)));
}

/**
 * Transcripts introduce people as `Nickname aka username`, so a fact copying
 * that shape ends up mentioning the same person twice in a row. Both halves
 * resolve to one id, and `<@1> (<@1>)` reads as a bug to anyone in the channel.
 */
function collapseRepeatedMentions(text: string): string {
  return text
    .replace(/<@(\d+)>\s*\(\s*<@\1>\s*\)/g, '<@$1>')
    .replace(/<@(\d+)>(?:\s+aka)?\s+<@\1>/g, '<@$1>');
}

/**
 * The single pass every fact goes through before it is stored: plain `@Name`
 * and the annotated `<@id>(Name)` form from transcripts are both reduced to a
 * bare `<@id>`, then any remaining names are mentionified.
 */
export function normaliseFactMentions(text: string, roster: Map<string, string>): string {
  return mentionifyNames(restoreMentions(text, roster), roster);
}

/**
 * Splits text on user mentions, capturing the id: with `String.split` on a
 * regex carrying one group, every odd index is an id and every even index is
 * ordinary text. Lets the admin panel render a mention as its own element
 * rather than flattening it into a string.
 */
export const USER_MENTION_SPLIT = /<@!?(\d+)>/;

/**
 * Splits text on any mention, keeping the markup itself: with one capture group,
 * every odd index is a whole `<@id>` or `<#id>` and every even index is ordinary
 * text. Keyed on the markup rather than the bare id so a user and a channel can
 * never be confused for one another.
 */
export const MENTION_SPLIT = /(<[@#]!?\d+>)/;

const ANY_MENTION = /<[@#]!?\d+>/g;

/** Every mention in a piece of text, as the markup, in order of first appearance. */
export function mentionsIn(text: string): string[] {
  return [...new Set(text.match(ANY_MENTION) ?? [])];
}

/** The id inside a mention, and whether it names a channel. */
export function readMention(markup: string): { id: string; isChannel: boolean } {
  return { id: markup.replace(/\D/g, ''), isChannel: markup.startsWith('<#') };
}

/** Every user id mentioned in a piece of text, in order of first appearance. */
export function mentionedUserIds(text: string): string[] {
  return [...new Set([...text.matchAll(USER_MENTION)].map((match) => match[1]))];
}
