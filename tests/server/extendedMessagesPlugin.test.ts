import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsBitField, type Client, type Message, type PermissionsString } from 'discord.js';
import type { BeforeReplyContext, DraftPrompt, PluginTool, PluginToolContext } from '@big-yahu/plugin-sdk';
import extendedMessagesPlugin from '../../src/server/plugins/bundled/extended-messages';
import {
  DEFAULT_CONFIG,
  type ExtendedMessagesConfig,
} from '../../src/server/plugins/bundled/extended-messages/config';
import { resetActionSlots } from '../../src/server/plugins/bundled/extended-messages/support';

const GUILD_ID = '100000000000000001';
const CHANNEL_ID = '200000000000000001';
const REQUESTER_ID = '300000000000000001';
const BOT_ID = '400000000000000001';
const TRIGGER_ID = '700000000000000001';
const TARGET_ID = '800000000000000001';
const GUILD_EMOJI_ID = '900000000000000001';
const FOREIGN_EMOJI_ID = '900000000000000002';

const EXPECTED_GATES = {
  send_poll: 'enablePolls',
  send_embed: 'enableEmbeds',
  add_reaction: 'enableReactions',
  who_reacted: 'enableWhoReacted',
  read_poll: 'enableReadPoll',
} as const satisfies Record<string, keyof ExtendedMessagesConfig>;

const tools = extendedMessagesPlugin.tools ?? [];

function tool(name: keyof typeof EXPECTED_GATES): PluginTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Extended Messages tool: ${name}`);
  return found;
}

/** One reaction, shaped like the parts of MessageReaction this plugin reads. */
function reaction(emoji: { name?: string; id?: string }, count: number, options: {
  me?: boolean;
  voters?: string[];
  onFetch?: (options: { limit?: number }) => void;
} = {}) {
  const voters = options.voters ?? [];
  return {
    emoji: { id: emoji.id ?? null, name: emoji.name ?? null },
    count,
    me: options.me ?? false,
    users: {
      fetch: vi.fn(async (fetchOptions: { limit?: number } = {}) => {
        options.onFetch?.(fetchOptions);
        const limit = fetchOptions.limit ?? voters.length;
        return new Map(voters.slice(0, limit).map((id) => [id, { id, bot: false }]));
      }),
    },
  };
}

/** One poll answer, shaped like the parts of PollAnswer this plugin reads. */
interface FakeAnswer {
  id?: number;
  /** Null is the real thing a partial answer carries, and must never reach the model as "null". */
  text?: string | null;
  emoji?: { name?: string; id?: string };
  votes: number;
  voters?: string[];
  onFetch?: (options: { limit?: number }) => void;
}

interface FakePollOptions {
  question?: string | null;
  answers: FakeAnswer[];
  /** Discord's own results.is_finalized, which is false until a poll ends. */
  finalized?: boolean;
  allowMultiselect?: boolean;
  expiresTimestamp?: number | null;
}

/** A poll shaped like the parts of discord.js's Poll this plugin reads off a fetched message. */
function fakePoll(options: FakePollOptions) {
  const answers = options.answers.map((answer, index) => {
    const id = answer.id ?? index + 1;
    const voters = answer.voters ?? [];
    return [id, {
      id,
      text: answer.text === undefined ? `option ${id}` : answer.text,
      emoji: answer.emoji
        ? { id: answer.emoji.id ?? null, name: answer.emoji.name ?? null }
        : null,
      voteCount: answer.votes,
      voters: {
        fetch: vi.fn(async (fetchOptions: { limit?: number } = {}) => {
          answer.onFetch?.(fetchOptions);
          const limit = fetchOptions.limit ?? voters.length;
          return new Map(voters.slice(0, limit).map((id2) => [id2, { id: id2, bot: false }]));
        }),
      },
    }] as const;
  });
  return {
    question: { text: options.question === undefined ? 'pizza or kebab' : options.question },
    answers: new Map(answers),
    resultsFinalized: options.finalized ?? false,
    allowMultiselect: options.allowMultiselect ?? false,
    expiresTimestamp: options.expiresTimestamp ?? null,
    voterFetches: answers.map(([, answer]) => answer.voters.fetch),
  };
}

interface Fakes {
  send: ReturnType<typeof vi.fn>;
  react: ReturnType<typeof vi.fn>;
  fetchMessage: ReturnType<typeof vi.fn>;
  client: Client;
}

interface ContextOptions {
  config?: Partial<ExtendedMessagesConfig>;
  permissions?: PermissionsString[];
  /** Reactions on the message a tool is pointed at. */
  reactions?: ReturnType<typeof reaction>[];
  /** The poll on the message a tool is pointed at, where there is one. */
  poll?: ReturnType<typeof fakePoll>;
  guildEmoji?: boolean;
  messageId?: string;
}

function fakes(options: ContextOptions): Fakes {
  const send = vi.fn(async () => ({ id: '950000000000000001' }));
  const react = vi.fn(async () => ({}));
  const fetchMessage = vi.fn(async () => ({
    id: TARGET_ID,
    react,
    reactions: { cache: new Map((options.reactions ?? []).map((entry, index) => [String(index), entry])) },
    // `Message#poll` is `Poll | null`, and null is what nearly every message has.
    poll: options.poll ?? null,
  }));
  const permissions = new PermissionsBitField(options.permissions
    ?? ['SendMessages', 'EmbedLinks', 'AddReactions', 'ReadMessageHistory', 'ViewChannel']);
  const channel = {
    id: CHANNEL_ID,
    isTextBased: () => true,
    permissionsFor: () => permissions,
    send,
    messages: { fetch: fetchMessage },
  };
  const guild = {
    id: GUILD_ID,
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
    emojis: {
      cache: new Map(options.guildEmoji === false
        ? []
        : [[GUILD_EMOJI_ID, { id: GUILD_EMOJI_ID, name: 'yahu' }]]),
    },
  };
  const client = {
    user: { id: BOT_ID },
    guilds: { cache: new Map([[GUILD_ID, guild]]) },
  } as unknown as Client;
  return { send, react, fetchMessage, client };
}

function context(options: ContextOptions = {}): PluginToolContext & Fakes {
  const built = fakes(options);
  return {
    ...built,
    discordClient: built.client,
    invocation: {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      messageId: options.messageId ?? TRIGGER_ID,
      requesterId: REQUESTER_ID,
      requesterIsController: false,
      requestContent: 'go on then',
    },
    getConfig: () => ({ ...DEFAULT_CONFIG, ...options.config }),
    resolveUserNames: (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `Person ${id.slice(-1)}`])),
  } as unknown as PluginToolContext & Fakes;
}

function refusal(result: unknown): string {
  expect(result).toMatchObject({ ok: false });
  const value = result as Record<string, unknown>;
  expect(typeof value.reason).toBe('string');
  // `ok: false` is what the host's `rejected` check reads, so a refusal here is
  // never mistaken for a success. It did not always cover `ok`; the host was
  // fixed rather than every plugin having to carry a duplicate `error` key.
  return value.reason as string;
}

const poll = {
  question: 'pizza or kebab',
  answers: [{ text: 'pizza' }, { text: 'kebab' }],
  durationHours: 24,
};

beforeEach(() => {
  resetActionSlots();
});

describe('Extended Messages declarations', () => {
  it('gates every tool on its own switch, and only the senders are effects', () => {
    for (const [name, gate] of Object.entries(EXPECTED_GATES)) {
      expect(tool(name as keyof typeof EXPECTED_GATES).enabledByConfig).toBe(gate);
      expect(DEFAULT_CONFIG[gate]).toBe(true);
    }
    // A poll, an embed and a reaction are all finished the moment they are sent:
    // another round trip would only invite the bot to narrate what it just did.
    expect(tool('send_poll').effect).toBe(true);
    expect(tool('send_embed').effect).toBe(true);
    expect(tool('add_reaction').effect).toBe(true);
    // who_reacted and read_poll both answer a question, so the model has to see
    // the answer: neither may be an effect tool.
    expect(tool('who_reacted').effect).toBeUndefined();
    expect(tool('read_poll').effect).toBeUndefined();
  });

  it('never offers a channel argument, so nothing can be posted outside the request', () => {
    for (const name of Object.keys(EXPECTED_GATES) as Array<keyof typeof EXPECTED_GATES>) {
      const properties = (tool(name).parameters as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(properties)).not.toContain('channelId');
      expect(Object.keys(properties)).not.toContain('guildId');
    }
  });

  it('declares every config key it reads, so the panel renders switches rather than a textarea', () => {
    const declared = new Set((extendedMessagesPlugin.configSchema ?? []).map((field) => field.name));
    for (const key of Object.keys(DEFAULT_CONFIG)) expect(declared).toContain(key);
  });
});

describe('Extended Messages config gates', () => {
  it('refuses each tool while its own switch is off, and does nothing to Discord', async () => {
    const cases: Array<[keyof typeof EXPECTED_GATES, Record<string, unknown>]> = [
      ['send_poll', poll],
      ['send_embed', { title: 'Rules', description: 'be nice' }],
      ['add_reaction', { messageId: TARGET_ID, emoji: '👍' }],
      ['who_reacted', { messageId: TARGET_ID }],
      ['read_poll', { messageId: TARGET_ID }],
    ];
    for (const [name, args] of cases) {
      const ctx = context({ config: { [EXPECTED_GATES[name]]: false } });
      const reason = refusal(await tool(name).handler(args, ctx));
      expect(reason).toMatch(/switched off/);
      expect(ctx.send).not.toHaveBeenCalled();
      expect(ctx.fetchMessage).not.toHaveBeenCalled();
    }
  });

  it('refuses when Discord has not granted the bot the permission the action needs', async () => {
    const withoutEmbedLinks = context({ permissions: ['SendMessages', 'ViewChannel'] });
    expect(refusal(await tool('send_embed').handler({ title: 'Rules' }, withoutEmbedLinks)))
      .toMatch(/Embed Links/);
    expect(withoutEmbedLinks.send).not.toHaveBeenCalled();

    const withoutAddReactions = context({ permissions: ['SendMessages', 'ReadMessageHistory'] });
    expect(refusal(await tool('add_reaction').handler({ messageId: TARGET_ID, emoji: '👍' }, withoutAddReactions)))
      .toMatch(/Add Reactions/);
    expect(withoutAddReactions.react).not.toHaveBeenCalled();
  });
});

describe('send_poll', () => {
  it('sends Discord\'s own poll payload, and can never mass-ping', async () => {
    const ctx = context();
    const result = await tool('send_poll').handler({ ...poll, allowMultiple: true }, ctx);
    expect(result).toMatchObject({ ok: true, messageId: '950000000000000001', answers: ['pizza', 'kebab'] });
    expect(ctx.send).toHaveBeenCalledWith({
      poll: {
        question: { text: 'pizza or kebab' },
        answers: [{ text: 'pizza' }, { text: 'kebab' }],
        duration: 24,
        allowMultiselect: true,
      },
      allowedMentions: { parse: ['users'] },
    });
  });

  it('refuses fewer than two and more than ten answers rather than quietly fixing the list', async () => {
    const tooFew = context();
    expect(refusal(await tool('send_poll').handler({ ...poll, answers: [{ text: 'pizza' }] }, tooFew)))
      .toMatch(/at least 2 answers/);
    expect(tooFew.send).not.toHaveBeenCalled();

    const tooMany = context();
    const answers = Array.from({ length: 11 }, (_entry, index) => ({ text: `option ${index}` }));
    expect(refusal(await tool('send_poll').handler({ ...poll, answers }, tooMany)))
      .toMatch(/at most 10 answers/);
    expect(tooMany.send).not.toHaveBeenCalled();
  });

  it('keeps a custom emoji only when this server actually has it', async () => {
    const ours = context();
    await tool('send_poll').handler({
      ...poll,
      answers: [{ text: 'pizza', emoji: `<:yahu:${GUILD_EMOJI_ID}>` }, { text: 'kebab', emoji: '🥙' }],
    }, ours);
    expect(ours.send.mock.calls[0][0].poll.answers).toEqual([
      { text: 'pizza', emoji: `yahu:${GUILD_EMOJI_ID}` },
      { text: 'kebab', emoji: '🥙' },
    ]);

    const theirs = context();
    expect(refusal(await tool('send_poll').handler({
      ...poll,
      answers: [{ text: 'pizza', emoji: `<:elsewhere:${FOREIGN_EMOJI_ID}>` }, { text: 'kebab' }],
    }, theirs))).toMatch(/does not have a custom emoji/);
    expect(theirs.send).not.toHaveBeenCalled();
  });
});

describe('send_embed', () => {
  it('builds the whole embed surface Discord accepts', async () => {
    const ctx = context();
    const result = await tool('send_embed').handler({
      title: 'House rules',
      description: 'read them',
      url: 'https://example.com/rules',
      color: '#5865F2',
      author: { name: 'Big Yahu', iconUrl: 'https://example.com/me.png' },
      thumbnail: 'https://example.com/thumb.png',
      image: 'https://example.com/big.png',
      footer: { text: 'as of today' },
      timestamp: '2026-10-01T09:00:00.000Z',
      fields: [{ name: 'one', value: 'be nice', inline: true }, { name: 'two', value: 'be brief' }],
    }, ctx);
    expect(result).toMatchObject({ ok: true, fields: 2 });
    const sent = ctx.send.mock.calls[0][0];
    expect(sent.allowedMentions).toEqual({ parse: ['users'] });
    expect(sent.embeds[0]).toEqual({
      title: 'House rules',
      description: 'read them',
      url: 'https://example.com/rules',
      color: 0x5865F2,
      author: { name: 'Big Yahu', icon_url: 'https://example.com/me.png' },
      thumbnail: { url: 'https://example.com/thumb.png' },
      image: { url: 'https://example.com/big.png' },
      footer: { text: 'as of today' },
      timestamp: '2026-10-01T09:00:00.000Z',
      fields: [{ name: 'one', value: 'be nice', inline: true }, { name: 'two', value: 'be brief', inline: false }],
    });
  });

  it('refuses what breaks a Discord limit instead of truncating it into nonsense', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ title: 'x'.repeat(257) }, /title must be at most 256/],
      [{ description: 'x'.repeat(4097) }, /description must be at most 4096/],
      [{
        title: 'too many',
        fields: Array.from({ length: 26 }, (_entry, index) => ({ name: `f${index}`, value: 'v' })),
      }, /at most 25 fields/],
      [{ fields: [{ name: 'x'.repeat(257), value: 'v' }] }, /fields\[0\]\.name must be at most 256/],
      [{ fields: [{ name: 'n', value: 'x'.repeat(1025) }] }, /fields\[0\]\.value must be at most 1024/],
      [{
        title: 'x'.repeat(256),
        description: 'x'.repeat(4096),
        fields: Array.from({ length: 2 }, () => ({ name: 'n'.repeat(256), value: 'v'.repeat(1024) })),
      }, /allows 6000 characters/],
    ];
    for (const [args, expected] of cases) {
      const ctx = context();
      expect(refusal(await tool('send_embed').handler(args, ctx))).toMatch(expected);
      expect(ctx.send).not.toHaveBeenCalled();
    }
  });

  it('refuses an embed with nothing in it but a colour', async () => {
    const ctx = context();
    expect(refusal(await tool('send_embed').handler({ color: '#000000' }, ctx)))
      .toMatch(/needs at least a title, a description or one field/);
    expect(ctx.send).not.toHaveBeenCalled();
  });
});

describe('add_reaction', () => {
  it('reacts with a unicode emoji on a message in the invocation\'s own channel', async () => {
    const ctx = context();
    expect(await tool('add_reaction').handler({ messageId: TARGET_ID, emoji: '😂' }, ctx))
      .toEqual({ ok: true, messageId: TARGET_ID, emoji: '😂' });
    expect(ctx.react).toHaveBeenCalledWith('😂');
  });

  it('reacts with one of this server\'s custom emoji, and refuses one it does not have', async () => {
    const ours = context();
    expect(await tool('add_reaction').handler({ messageId: TARGET_ID, emoji: `yahu:${GUILD_EMOJI_ID}` }, ours))
      .toMatchObject({ ok: true, emoji: `yahu:${GUILD_EMOJI_ID}` });
    expect(ours.react).toHaveBeenCalledWith(`yahu:${GUILD_EMOJI_ID}`);

    const theirs = context();
    expect(refusal(await tool('add_reaction').handler(
      { messageId: TARGET_ID, emoji: `<a:elsewhere:${FOREIGN_EMOJI_ID}>` },
      theirs,
    ))).toMatch(new RegExp(`does not have a custom emoji with id ${FOREIGN_EMOJI_ID}`));
    expect(theirs.react).not.toHaveBeenCalled();

    const gone = context({ guildEmoji: false });
    expect(refusal(await tool('add_reaction').handler(
      { messageId: TARGET_ID, emoji: `yahu:${GUILD_EMOJI_ID}` },
      gone,
    ))).toMatch(/does not have a custom emoji/);
    expect(gone.react).not.toHaveBeenCalled();
  });

  it('refuses an emoji name and an invented message id', async () => {
    const named = context();
    expect(refusal(await tool('add_reaction').handler({ messageId: TARGET_ID, emoji: 'thumbsup' }, named)))
      .toMatch(/must be the emoji character itself/);
    const colons = context();
    expect(refusal(await tool('add_reaction').handler({ messageId: TARGET_ID, emoji: ':thumbsup:' }, colons)))
      .toMatch(/has no id/);
    const bad = context();
    expect(refusal(await tool('add_reaction').handler({ messageId: '12', emoji: '👍' }, bad)))
      .toMatch(/messageId must be a Discord id/);
    expect(bad.fetchMessage).not.toHaveBeenCalled();
  });
});

describe('who_reacted', () => {
  it('names the people behind each reaction, within both of its caps', async () => {
    const limits: Array<number | undefined> = [];
    const ctx = context({
      config: { whoReactedMaxReactions: 2, whoReactedMaxUsers: 2 },
      reactions: [
        reaction({ name: '😂' }, 3, {
          voters: ['510000000000000001', '510000000000000002', '510000000000000003'],
          onFetch: (options) => limits.push(options.limit),
        }),
        reaction({ name: 'yahu', id: GUILD_EMOJI_ID }, 1, {
          voters: ['510000000000000004'],
          onFetch: (options) => limits.push(options.limit),
        }),
        reaction({ name: '👍' }, 9, { voters: ['510000000000000005'] }),
      ],
    });

    const result = await tool('who_reacted').handler({ messageId: TARGET_ID }, ctx) as Record<string, unknown>;
    // Only the two reactions the cap allows were looked up at all, and the third
    // is reported rather than silently missing.
    expect(limits).toEqual([2, 2]);
    expect(result).toMatchObject({ ok: true, messageId: TARGET_ID, reactionsNotLookedUp: 1 });
    expect(result.reactions).toEqual([
      {
        emoji: '😂',
        count: 3,
        people: [
          { id: '510000000000000001', name: 'Person 1' },
          { id: '510000000000000002', name: 'Person 2' },
        ],
        andOthers: 1,
      },
      {
        emoji: `yahu:${GUILD_EMOJI_ID}`,
        count: 1,
        people: [{ id: '510000000000000004', name: 'Person 4' }],
      },
    ]);
    // Forced, or a cached copy's counts would be as old as the copy.
    expect(ctx.fetchMessage).toHaveBeenCalledWith({ message: TARGET_ID, force: true });
  });
});

describe('read_poll', () => {
  const VOTER_A = '520000000000000001';
  const VOTER_B = '520000000000000002';
  const VOTER_C = '520000000000000003';
  const VOTER_D = '520000000000000004';

  it('reads a running poll back, and never states its counts as the final ones', async () => {
    const closesAt = Date.now() + 3_600_000;
    const ctx = context({
      config: { enablePollVoters: false },
      poll: fakePoll({
        answers: [{ text: 'pizza', votes: 11 }, { text: 'kebab', votes: 4 }],
        allowMultiselect: true,
        expiresTimestamp: closesAt,
      }),
    });

    const result = await tool('read_poll').handler({ messageId: TARGET_ID }, ctx) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      messageId: TARGET_ID,
      question: 'pizza or kebab',
      // Discord does not promise a count is exact until a poll ends, so this
      // flag is on every payload and says outright that these are not final.
      voteCountsFinal: false,
      multipleChoice: true,
      expiresAt: new Date(closesAt).toISOString(),
    });
    expect(result.closed).toBeUndefined();
    expect(result.answers).toEqual([
      { id: 1, text: 'pizza', votes: 11 },
      { id: 2, text: 'kebab', votes: 4 },
    ]);
    // Forced, or a cached copy's vote counts would be as old as the copy.
    expect(ctx.fetchMessage).toHaveBeenCalledWith({ message: TARGET_ID, force: true });
  });

  it('says a finished poll is finished, so its numbers can be given as the result', async () => {
    const ctx = context({
      config: { enablePollVoters: false },
      poll: fakePoll({
        answers: [{ text: 'pizza', votes: 11 }],
        finalized: true,
        expiresTimestamp: Date.now() - 60_000,
      }),
    });
    expect(await tool('read_poll').handler({ messageId: TARGET_ID }, ctx))
      .toMatchObject({ ok: true, voteCountsFinal: true, closed: true });
  });

  it('treats a poll whose time is up as closed even before Discord finalises the counts', async () => {
    const ctx = context({
      config: { enablePollVoters: false },
      poll: fakePoll({ answers: [{ text: 'pizza', votes: 1 }], expiresTimestamp: Date.now() - 1_000 }),
    });
    expect(await tool('read_poll').handler({ messageId: TARGET_ID }, ctx))
      .toMatchObject({ ok: true, closed: true, voteCountsFinal: false });
  });

  it('names who voted for what, within both of its caps, and says where a list was cut', async () => {
    const limits: Array<number | undefined> = [];
    const poll = fakePoll({
      answers: [
        { text: 'pizza', votes: 3, voters: [VOTER_A, VOTER_B, VOTER_C], onFetch: (o) => limits.push(o.limit) },
        { text: 'kebab', votes: 1, voters: [VOTER_D], onFetch: (o) => limits.push(o.limit) },
        { text: 'neither', votes: 7, voters: [VOTER_A], onFetch: (o) => limits.push(o.limit) },
      ],
    });
    const ctx = context({ config: { readPollMaxAnswers: 2, readPollMaxVoters: 2 }, poll });

    const result = await tool('read_poll').handler({ messageId: TARGET_ID }, ctx) as Record<string, unknown>;
    // Only the two answers the cap allows cost a call at all.
    expect(limits).toEqual([2, 2]);
    expect(poll.voterFetches[2]).not.toHaveBeenCalled();
    expect(result.answers).toEqual([
      {
        id: 1,
        text: 'pizza',
        votes: 3,
        people: [{ id: VOTER_A, name: 'Person 1' }, { id: VOTER_B, name: 'Person 2' }],
        // The third vote is said outright rather than left to look like two.
        andOthers: 1,
      },
      { id: 2, text: 'kebab', votes: 1, people: [{ id: VOTER_D, name: 'Person 4' }] },
      // Still counted, but nobody was looked up, and that is on the answer.
      { id: 3, text: 'neither', votes: 7, votersNotLookedUp: true },
    ]);
  });

  it('leaves the voters alone entirely while that switch is off', async () => {
    const poll = fakePoll({ answers: [{ text: 'pizza', votes: 3, voters: [VOTER_A] }] });
    const ctx = context({ config: { enablePollVoters: false }, poll });

    const result = await tool('read_poll').handler({ messageId: TARGET_ID }, ctx) as Record<string, unknown>;
    expect(poll.voterFetches[0]).not.toHaveBeenCalled();
    // Not an empty list and not a marker: the counts come back, the names do not.
    expect(result.answers).toEqual([{ id: 1, text: 'pizza', votes: 3 }]);
    expect(JSON.stringify(result)).not.toContain('people');
  });

  it('reports an answer Discord gave no text without ever writing the word null', async () => {
    const ctx = context({
      config: { enablePollVoters: false },
      poll: fakePoll({
        question: null,
        answers: [{ text: null, emoji: { name: '🍕' }, votes: 2 }, { text: null, votes: 1 }],
      }),
    });

    const result = await tool('read_poll').handler({ messageId: TARGET_ID }, ctx) as Record<string, unknown>;
    expect(result.answers).toEqual([
      // The emoji identifies it; the answer id is what is left when nothing else does.
      { id: 1, emoji: '🍕', votes: 2 },
      { id: 2, votes: 1 },
    ]);
    expect(result.question).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('null');
  });

  it('says plainly that a message carries no poll rather than throwing', async () => {
    const ctx = context();
    expect(refusal(await tool('read_poll').handler({ messageId: TARGET_ID }, ctx)))
      .toMatch(/does not carry a poll/);
  });

  it('refuses an invented message id before it goes anywhere near Discord', async () => {
    const ctx = context({ poll: fakePoll({ answers: [{ votes: 1 }] }) });
    expect(refusal(await tool('read_poll').handler({ messageId: '12' }, ctx)))
      .toMatch(/messageId must be a Discord id/);
    expect(ctx.fetchMessage).not.toHaveBeenCalled();
  });

  it('refuses without Read Message History, rather than letting Discord say no', async () => {
    const ctx = context({
      permissions: ['SendMessages', 'ViewChannel'],
      poll: fakePoll({ answers: [{ votes: 1 }] }),
    });
    expect(refusal(await tool('read_poll').handler({ messageId: TARGET_ID }, ctx)))
      .toMatch(/Read Message History/);
    expect(ctx.fetchMessage).not.toHaveBeenCalled();
  });
});

describe('the per-reply cap', () => {
  it('stops one reply firing more of these than the operator allows', async () => {
    const options: ContextOptions = { config: { maxActionsPerReply: 2 } };
    expect(await tool('send_poll').handler(poll, context(options))).toMatchObject({ ok: true });
    expect(await tool('add_reaction').handler({ messageId: TARGET_ID, emoji: '👍' }, context(options)))
      .toMatchObject({ ok: true });

    const third = context(options);
    expect(refusal(await tool('send_embed').handler({ title: 'Rules' }, third))).toMatch(/is the limit/);
    expect(third.send).not.toHaveBeenCalled();

    // The budget belongs to the turn, not to the process: a different Discord
    // message is a different reply and starts again.
    const nextReply = context({ ...options, messageId: '700000000000000002' });
    expect(await tool('send_embed').handler({ title: 'Rules' }, nextReply)).toMatchObject({ ok: true });
  });
});

describe('what the reply prompt gains from the channel', () => {
  const draft = (): DraftPrompt => ({
    systemInstruction: 'be yourself',
    material: {
      messages: [
        { id: '810000000000000001', at: 'then', authorId: '111', content: 'a joke' },
        { id: '810000000000000002', at: 'then', authorId: 'you', content: 'my line' },
      ],
      quoted: [{ id: '810000000000000003', at: 'earlier', authorId: '222', content: 'the quoted one' }],
    },
    images: [],
    retrievedFacts: [],
    sourceMessages: [],
  });

  function replyContext(options: {
    config?: Partial<ExtendedMessagesConfig>;
    messages?: Array<{
      id: string;
      reactions?: ReturnType<typeof reaction>[];
      poll?: ReturnType<typeof fakePoll>;
    }>;
  } = {}): BeforeReplyContext & { fetch: ReturnType<typeof vi.fn> } {
    const fetch = vi.fn(async (_options: { limit?: number }) => new Map(
      (options.messages ?? []).map((entry) => [entry.id, {
        id: entry.id,
        reactions: { cache: new Map((entry.reactions ?? []).map((value, index) => [String(index), value])) },
        // Discord returns a poll with its message, so this arrives in the same
        // payload the reactions do — null on every message that is not a poll.
        poll: entry.poll ?? null,
      } as unknown as Message]),
    ));
    return {
      taggedMessage: { channel: { messages: { fetch } } },
      draftPrompt: draft(),
      getConfig: () => ({ ...DEFAULT_CONFIG, ...options.config }),
      fetch,
    } as unknown as BeforeReplyContext & { fetch: ReturnType<typeof vi.fn> };
  }

  it('attaches what people reacted with to the messages they are on, in one fetch', async () => {
    const ctx = replyContext({
      config: { reactionSummaryMessages: 25 },
      messages: [
        {
          id: '810000000000000001',
          reactions: [reaction({ name: '😂' }, 3), reaction({ name: 'yahu', id: GUILD_EMOJI_ID }, 1, { me: true })],
        },
        { id: '810000000000000003', reactions: [reaction({ name: '👍' }, 2)] },
      ],
    });

    const result = await extendedMessagesPlugin.beforeReply!(ctx);
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
    expect(ctx.fetch).toHaveBeenCalledWith({ limit: 25 });

    const material = (result as { draftPrompt: DraftPrompt }).draftPrompt.material;
    expect(material.messages).toEqual([
      {
        id: '810000000000000001',
        at: 'then',
        authorId: '111',
        content: 'a joke',
        reactions: [
          { emoji: '😂', count: 3 },
          { emoji: `yahu:${GUILD_EMOJI_ID}`, count: 1, mine: true },
        ],
      },
      // Nobody reacted to this one, so it gains nothing.
      { id: '810000000000000002', at: 'then', authorId: 'you', content: 'my line' },
    ]);
    expect(material.quoted).toEqual([{
      id: '810000000000000003', at: 'earlier', authorId: '222', content: 'the quoted one',
      reactions: [{ emoji: '👍', count: 2 }],
    }]);
  });

  it('fetches nothing at all while both features are off, or the window is zero', async () => {
    for (const config of [
      { enableReactionSummary: false, enablePollSummary: false },
      { reactionSummaryMessages: 0 },
    ]) {
      const ctx = replyContext({ config });
      expect(await extendedMessagesPlugin.beforeReply!(ctx)).toBeUndefined();
      expect(ctx.fetch).not.toHaveBeenCalled();
    }
  });

  it('hands the draft back untouched when there is no reaction and no poll about', async () => {
    const ctx = replyContext({ messages: [{ id: '810000000000000001', reactions: [] }] });
    // Not an empty field on every reply: the material is sent with every call.
    expect(await extendedMessagesPlugin.beforeReply!(ctx)).toBeUndefined();
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
  });

  it('attaches a poll\'s standing to the message carrying it, counts and all', async () => {
    const closesAt = Date.now() + 7_200_000;
    const ctx = replyContext({
      messages: [{
        id: '810000000000000002',
        poll: fakePoll({
          answers: [{ text: 'pizza', votes: 11 }, { text: 'kebab', emoji: { name: '🥙' }, votes: 4 }],
          allowMultiselect: true,
          expiresTimestamp: closesAt,
        }),
      }],
    });

    const result = await extendedMessagesPlugin.beforeReply!(ctx);
    const material = (result as { draftPrompt: DraftPrompt }).draftPrompt.material;
    expect((material.messages as Array<Record<string, unknown>>)[1]).toEqual({
      id: '810000000000000002',
      at: 'then',
      authorId: 'you',
      content: 'my line',
      poll: {
        question: 'pizza or kebab',
        answers: [
          { id: 1, text: 'pizza', votes: 11 },
          { id: 2, text: 'kebab', emoji: '🥙', votes: 4 },
        ],
        // Carried whichever way it reads: a missing flag would be read as "safe
        // to state as the result", which is exactly what it is not.
        voteCountsFinal: false,
        multipleChoice: true,
        expiresAt: new Date(closesAt).toISOString(),
      },
    });
    // The message nobody polled or reacted to gains nothing at all.
    expect((material.messages as Array<Record<string, unknown>>)[0].poll).toBeUndefined();
  });

  it('adds no Discord call for the poll state: one fetch carries both', async () => {
    const both = () => [
      {
        id: '810000000000000001',
        reactions: [reaction({ name: '😂' }, 3)],
        poll: fakePoll({ answers: [{ text: 'pizza', votes: 2 }], finalized: true }),
      },
    ];

    // Reactions on their own: one fetch.
    const reactionsOnly = replyContext({ config: { enablePollSummary: false }, messages: both() });
    await extendedMessagesPlugin.beforeReply!(reactionsOnly);
    expect(reactionsOnly.fetch).toHaveBeenCalledTimes(1);

    // Poll state as well: still one fetch, because the poll came back in that
    // same payload. Switching it on is free.
    const withPolls = replyContext({ messages: both() });
    const result = await extendedMessagesPlugin.beforeReply!(withPolls);
    expect(withPolls.fetch).toHaveBeenCalledTimes(1);

    const line = ((result as { draftPrompt: DraftPrompt }).draftPrompt
      .material.messages as Array<Record<string, unknown>>)[0];
    expect(line.reactions).toEqual([{ emoji: '😂', count: 3 }]);
    expect(line.poll).toEqual({
      question: 'pizza or kebab',
      answers: [{ id: 1, text: 'pizza', votes: 2 }],
      voteCountsFinal: true,
      closed: true,
    });

    // And the poll state on its own is one fetch too, not a second one.
    const pollsOnly = replyContext({ config: { enableReactionSummary: false }, messages: both() });
    const pollResult = await extendedMessagesPlugin.beforeReply!(pollsOnly);
    expect(pollsOnly.fetch).toHaveBeenCalledTimes(1);
    const pollLine = ((pollResult as { draftPrompt: DraftPrompt }).draftPrompt
      .material.messages as Array<Record<string, unknown>>)[0];
    expect(pollLine.reactions).toBeUndefined();
    expect(pollLine.poll).toBeDefined();
  });

  it('hands the draft back untouched when no message in the window carries a poll', async () => {
    const ctx = replyContext({
      config: { enableReactionSummary: false },
      messages: [{ id: '810000000000000001', reactions: [reaction({ name: '😂' }, 3)] }],
    });
    // The reactions are there but switched off, and there is no poll: nothing to
    // attach, so the material is not rebuilt around an empty field.
    expect(await extendedMessagesPlugin.beforeReply!(ctx)).toBeUndefined();
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
  });

  it('never writes the word null for an answer Discord gave no text', async () => {
    const ctx = replyContext({
      config: { enableReactionSummary: false },
      messages: [{
        id: '810000000000000001',
        poll: fakePoll({ answers: [{ text: null, emoji: { name: 'yahu', id: GUILD_EMOJI_ID }, votes: 2 }] }),
      }],
    });

    const result = await extendedMessagesPlugin.beforeReply!(ctx);
    const material = (result as { draftPrompt: DraftPrompt }).draftPrompt.material;
    const line = (material.messages as Array<Record<string, unknown>>)[0];
    expect(line.poll).toEqual({
      question: 'pizza or kebab',
      // Named by the emoji it was labelled with, with its id left to identify it.
      answers: [{ id: 1, emoji: `yahu:${GUILD_EMOJI_ID}`, votes: 2 }],
      voteCountsFinal: false,
    });
    expect(JSON.stringify(material)).not.toContain('null');
  });

  it('keeps the reply going when Discord will not let it read the channel', async () => {
    const ctx = replyContext({ messages: [] });
    ctx.fetch.mockRejectedValueOnce(new Error('Missing Access'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await extendedMessagesPlugin.beforeReply!(ctx)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
