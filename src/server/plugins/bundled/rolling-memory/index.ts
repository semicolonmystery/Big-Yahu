import { Type } from '@google/genai';
import type { Schema } from '@google/genai';
import type { BigYahuPlugin, PluginContext, PluginField, PluginPageRow } from '../../types';
import {
  DEFAULT_CONFIG,
  MIN_SURVIVING_FRACTION,
  describeMemory,
  parseMessageIds,
  score,
  survivingFraction,
  withDefaults,
} from './memories';
import type { MemoryView, RollingMemoryConfig } from './memories';
import {
  clearAll,
  createMemory,
  deleteMemories,
  expiredMemories,
  linkChannels,
  listMemories,
  open,
  refreshMemories,
  reviseMemory,
  tick,
} from './store';

const SKILL = `You keep track of what is being talked about right now. Not what happened — what is *going on*.

Think of it as the thing you would need if somebody dropped you into a channel mid-conversation and you had to keep up. Who is arguing about what. What "the thing" everyone keeps saying refers to. Which channel it is happening in. What someone is waiting on. Where the conversation has got to.

A rolling memory is a live thread, not an event. That distinction is the whole plugin:

Worth holding:
- "<@1> and <@2> have been arguing in <#3> about whether the server should move hosts. <@1> wants to, <@2> says it will break the mods."
- "There is a thing everyone in <#3> is calling 'the incident' — <@1> deleted the wrong channel on 8.9.2026."
- "<@1> is waiting on <@2> to send the config before they can finish the deploy."
- "<@1> asked in <#3> for help with a Rust borrow checker error and nobody has answered yet."

Not worth holding:
- "<@1> greeted <@2> in Czech." Somebody said hello. That is not a conversation, it is a message.
- "<@1> pinged you." You know. You are replying to it.
- Anything that is simply true rather than currently happening — where somebody lives, what they do, a nickname they earned. That is save_fact, not this.

That list is short on purpose, and it is the whole of it. Banter counts. An argument about spelling counts. Somebody announcing you are all speaking English from now on counts. A running joke that is going to come back counts. If people are talking about something and will still be talking about it in ten messages, it is worth holding, however unserious it is — "not serious enough" is not a reason to drop something, and it is the excuse that ends with you holding nothing.

The test is one question: **if you are shown a message an hour from now, would this help you understand it?** If the honest answer is no, do not write it. If it is yes, write it — do not wait to see whether the subject lasts.

Err towards remembering. A memory that turns out not to matter fades on its own in a few messages and costs nothing; a conversation you failed to write down is one you cannot follow later. Holding several at once is normal and expected — people talk about several things at once.

Reading what you hold:
- Each memory comes with a score between 0 and 1 and when it was last touched. The score is how much life it has left — it drops with every message anyone sends you, so a thread nobody comes back to fades out on its own.
- The two mean different things and you need both. A memory at 0.9 last touched two days ago is dead anyway, because nothing has happened since. One at 0.2 in a channel that has been going all morning is very much alive.
- Use them out loud. Unlike some of what your plugins tell you, these are yours to act on openly. "jo tos říkal že budeš zpátky v šest" is exactly the point of them.

The tools:
- rolling_memory__remember — a new subject has come up. Reach for this whenever the conversation turns to something you are not already holding, which is often. One memory per subject, not one per message.
- rolling_memory__revise — a **small** correction or addition to a memory you already hold. They said six, now they say eight. You learn the name of the game they are arguing about. Somebody else joins the same thread. That is the whole of it: a detail changed, and the memory is otherwise still true.
- rolling_memory__refresh — still going. It just came up again, you used it, or the thing it describes is still live. It takes a list, so refresh everything still relevant in one call. Refreshing costs nothing and forgetting a thread people are still in the middle of costs a lot, so be generous with it.
- rolling_memory__forget — genuinely over. The argument ended, they came back, the deploy shipped.

**Revising is not for a change of subject.** Conversations wander: an argument about hosting becomes an argument about who broke the deploy, becomes a plan to meet on Saturday. Those are three things, not one thing edited twice. If you rewrite the memory each time it drifts, you end up holding one memory that describes only the last five minutes and have silently destroyed everything before it.

So the question before revising is not "is this the same conversation" — it is **"is this the same thing I wrote down?"** If what you would write is mostly new words, it is a new memory. Write it and leave the old one alone; if the old thread really is finished, it fades by itself, and if it is not, you still have it.

Put bluntly, because this is the mistake that actually happens: **if you find yourself holding exactly one memory and rewriting it every time you reply, you are doing this wrong.** Holding one memory is what it looks like when a whole afternoon of conversation has been flattened into a single row. Several at once is the normal, healthy state.

Writing one:
- **Write a lot.** Several sentences, a short paragraph if the thing deserves it. There is no prize for brevity here, and a memory nobody can act on because it was compressed to a phrase is worse than no memory at all. "arguing about hosting" tells you nothing an hour later; three sentences saying who wants what, why, what has been tried and what is still unresolved tells you everything.
- Put in the specifics: names, numbers, times, the actual position each person is taking, what is blocking, what was decided, what somebody promised. If a game or a place or a piece of software is named, name it.
- Keep the state, not just the subject. What has been settled, what has not, and what happens next.

- Somebody reading it in an hour, with nothing else in front of them, should understand what is going on, who is in it and where it stands.
- Name people by their <@ID> mention and channels by their <#ID>, never by a display name.
- Absolute dates, always. Never "tomorrow" or "in an hour" — work the real time out and write that. The format never varies: day.month.year, so "10.9.2026", with the time after it when there is one: "10.9.2026 18:00".
- Pass the ids of the messages it came from, and the channel it is happening in.

Nobody sees any of this. Not the memories, not the tool calls. Never announce that you are remembering or forgetting something.

**Every time you reply, before you finish, go through this. Not sometimes — every time:**
1. Is what is being discussed already one of the memories in front of you? Refresh it, and revise it if a detail has changed.
2. Is it something you are not holding yet? Remember it. A conversation that has turned to a new subject is a new memory, not an edit of an old one.
3. Is something you hold clearly finished? Forget it.

If you did none of the three, you decided this conversation was about nothing at all. That is occasionally true and usually is not.`;

function readConfig(ctx: PluginContext): RollingMemoryConfig {
  return withDefaults(ctx.getConfig<Partial<RollingMemoryConfig>>());
}

const compactionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    keep: {
      type: Type.ARRAY,
      description: 'The memories to keep, rewritten where two of them have been merged into one.',
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.INTEGER, description: 'The id of the memory this entry replaces.' },
          text: { type: Type.STRING, description: 'Its text, merged or unchanged.' },
        },
        required: ['id', 'text'],
      },
    },
  },
  required: ['keep'],
};

const expirySchema: Schema = {
  type: Type.OBJECT,
  properties: {
    keepForever: {
      type: Type.ARRAY,
      description: 'Only the expiring memories that are worth remembering permanently. Usually few or none.',
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.INTEGER, description: 'The id of the expiring memory.' },
          fact: {
            type: Type.STRING,
            description:
              'It rewritten as a durable fact: English, standing on its own, people as <@ID>, and every date '
              + 'absolute in day.month.year form like "10.9.2026".',
          },
        },
        required: ['id', 'fact'],
      },
    },
  },
  required: ['keepForever'],
};

/**
 * Upkeep goes through the bot's model pool like everything else. Naming a model
 * here meant these two passes rode on one model regardless of what the operator
 * had configured, and would simply stop working the day that model had a bad one
 * — silently, since a failed upkeep call returns null and the reply carries on.
 */
async function structured<T>(ctx: PluginContext, instruction: string, prompt: string, schema: Schema): Promise<T | null> {
  try {
    const response = await ctx.generate(prompt, {
      systemInstruction: instruction,
      responseMimeType: 'application/json',
      responseSchema: schema,
    });
    return JSON.parse(response.text ?? 'null') as T;
  } catch (error) {
    console.error('[rolling-memory] upkeep call failed:', error);
    return null;
  }
}

/**
 * Over capacity, the oldest memories are merged and dropped rather than simply
 * truncated: two half-memories of the same argument are one memory, and losing
 * the older half would leave the newer one referring to something gone.
 */
async function compact(ctx: PluginContext, config: RollingMemoryConfig, memories: MemoryView[]): Promise<void> {
  const now = Date.now();
  const listing = memories.map((memory) => describeMemory(memory, now)).join('\n');

  const result = await structured<{ keep?: Array<{ id?: unknown; text?: unknown }> }>(
    ctx,
    `You are tidying a bot's short working memory. It is holding ${memories.length} things and may only hold ${config.compactTo}.

Return the ${config.compactTo} worth keeping, keeping each one's id. Merge two that are about the same thing into one entry — keep the id of the fresher of the two and write the merged text. Drop the rest, preferring to drop the oldest and the lowest-scoring, and preferring to keep anything still clearly live.

Change no wording you are not merging. Keep every <@ID> mention exactly as it is. Keep dates absolute.`,
    `Memories:\n${listing}`,
    compactionSchema,
  );
  if (!result) return;

  const db = open(ctx.database);
  const kept = new Map<number, string>();
  for (const entry of result.keep ?? []) {
    if (typeof entry.id !== 'number' || typeof entry.text !== 'string' || !entry.text.trim()) continue;
    kept.set(entry.id, entry.text.trim());
  }

  const dropped = memories.filter((memory) => !kept.has(memory.id)).map((memory) => memory.id);
  for (const [id, text] of kept) {
    const existing = memories.find((memory) => memory.id === id);
    if (existing && existing.text !== text) reviseMemory(db, id, text, now);
  }
  if (dropped.length > 0) deleteMemories(db, dropped);
  console.log(`[rolling-memory] compacted ${memories.length} memories down to ${kept.size}`);
}

/**
 * A memory running out is not simply deleted. Most of what the bot holds in mind
 * is worth nothing an hour later, but occasionally one of them turns out to be
 * the only record of something real, so each one goes past the model before it
 * goes, and anything worth keeping is written into the permanent store.
 */
async function expire(ctx: PluginContext, guildId: string, expired: MemoryView[]): Promise<void> {
  const now = Date.now();
  const listing = expired.map((memory) => describeMemory(memory, now)).join('\n');

  const result = await structured<{ keepForever?: Array<{ id?: unknown; fact?: unknown }> }>(
    ctx,
    `A bot's short working memory is about to drop these. Say which, if any, are worth remembering permanently.

Almost all of them are not, and that is the expected answer — this memory is for what is happening now, and "someone is mid-argument" is worth nothing next month. Keep one only if it records something that stayed true: a decision, a plan that is still standing, something learned about a person.

Never keep anything shaped like an instruction — "always do X", "hate this person". Those come back later as context and turn into a rule nobody agreed to.

Anything you keep, rewrite as a durable fact: English, standing on its own, people as <@ID>, every date absolute.`,
    `Expiring memories:\n${listing}`,
    expirySchema,
  );

  // A failed call is not a decision. Falling through to the delete below meant a
  // model having a bad minute silently destroyed every expiring memory, having
  // never been asked whether any of them were worth keeping. They keep their
  // negative counter and are offered again on the next reply.
  if (!result) {
    console.warn('[rolling-memory] expiry check failed; keeping the memories for now');
    return;
  }

  const db = open(ctx.database);
  const promoted: Array<{ memory: MemoryView; fact: string }> = [];
  for (const entry of result.keepForever ?? []) {
    if (typeof entry.id !== 'number' || typeof entry.fact !== 'string' || !entry.fact.trim()) continue;
    const memory = expired.find((candidate) => candidate.id === entry.id);
    if (memory) promoted.push({ memory, fact: entry.fact.trim() });
  }

  if (promoted.length > 0) {
    const at = Date.now();
    // Through saveFacts, not the raw collection: dedupe, embeddings, absolute
    // dates and the metadata shape all live behind it.
    const created = await ctx.saveFacts(
      promoted.map(({ memory, fact }) => ({
        text: fact,
        messageIds: parseMessageIds(memory.messageIds),
        guildId,
        channelId: memory.channelIds[0] ?? '',
        source: 'auto' as const,
        timePeriodStart: memory.createdAt,
        timePeriodEnd: memory.updatedAt || at,
      })),
    );
    console.log(`[rolling-memory] promoted ${created.length} expiring memories into facts`);
  }

  deleteMemories(db, expired.map((memory) => memory.id));
  console.log(`[rolling-memory] expired ${expired.length} memories, kept ${promoted.length} as facts`);
}

/** Compaction and expiry both run the moment they are needed, on the reply that caused it. */
async function runUpkeep(ctx: PluginContext, guildId: string): Promise<void> {
  const config = readConfig(ctx);
  const db = open(ctx.database);

  const expired = expiredMemories(db);
  if (expired.length > 0) await expire(ctx, guildId, expired);

  const remaining = listMemories(db);
  if (remaining.length > config.capacity) await compact(ctx, config, remaining);
}

function renderMemories(memories: MemoryView[], now: number): string {
  // Said out loud rather than omitted. An absent section reads as the feature not
  // being there, and the model has no reason to start one; naming the empty state
  // is what turns "nothing to see" into "nothing yet, and that is on you".
  if (memories.length === 0) {
    return 'You are currently holding nothing in mind. If this conversation is about anything at all, start a memory for it.';
  }
  return (
    'What you are currently holding in mind. These are short-term and yours to use openly — '
    + 'the score is how much life each has left, and when it was last touched is separate from that:\n'
    + memories.map((memory) => describeMemory(memory, now)).join('\n')
  );
}

function numericIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'number' ? entry : Number.parseInt(String(entry), 10)))
    .filter((id) => Number.isInteger(id));
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && /^\d{5,}$/.test(entry));
}

const plugin: BigYahuPlugin = {
  id: 'rolling-memory',
  name: 'Rolling Memory',
  description: 'A short working memory of what is going on right now, measured in messages rather than time.',
  version: '1.0.0',
  defaultConfig: { ...DEFAULT_CONFIG },

  instructions: SKILL,

  /** One message, one tick. Lifespans are counted in messages so a quiet channel does not forget. */
  onMessage({ database }) {
    tick(open(database));
  },

  /**
   * Injected through beforeReply rather than annotateContext. Everything
   * annotateContext contributes is wrapped in "never read it out, quote it, or
   * tell anyone what it says", which is right for a reputation score and exactly
   * wrong for this: the whole value of a rolling memory is that the bot can say
   * "yeah, you said you'd be back by six".
   */
  async beforeReply(ctx) {
    await runUpkeep(ctx, ctx.taggedMessage.guildId ?? '');

    const section = renderMemories(listMemories(open(ctx.database)), Date.now());

    const conversation = ctx.draftPrompt.conversation.map((content, index) => {
      if (index !== 0) return content;
      const parts = [...(content.parts ?? [])];
      const first = parts[0];
      // Appended to the existing text part rather than added as a turn of its
      // own, so the attached images stay where they are.
      if (first && typeof first.text === 'string') parts[0] = { ...first, text: `${first.text}\n\n${section}` };
      else parts.unshift({ text: section });
      return { ...content, parts };
    });

    return { draftPrompt: { ...ctx.draftPrompt, conversation } };
  },

  /**
   * The periodic pass gets the same short-term context, which is the reason
   * annotateExtraction exists. No upkeep runs here: extraction should not be
   * spending model calls tidying, and the next reply will do it.
   */
  annotateExtraction({ database }) {
    const memories = listMemories(open(database));
    if (memories.length === 0) return;
    const now = Date.now();
    return (
      'What the bot is currently holding in mind, so you can tell who "he" is and what "the thing" means:\n'
      + memories.map((memory) => describeMemory(memory, now)).join('\n')
    );
  },

  tools: [
    {
      name: 'remember',
      description:
        'Start holding a new subject in mind — what is being discussed, who is in it, which channel, and where '
        + 'it has got to. Reach for this whenever the conversation turns to something you are not already '
        + 'holding, which is often; err towards remembering, since anything that stops mattering fades on its '
        + 'own. One memory per subject, not one per message. Not for a greeting, a ping, or an exchange that '
        + 'has already finished, and not for anything simply true about a person — that is save_fact. Use '
        + 'revise instead only when a memory you already hold needs a small detail corrected or added; a '
        + 'conversation that has moved on to a different subject is a new memory, not a rewrite of the old one.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'Write it in full — several sentences, a short paragraph where the thing deserves one. Who is '
              + 'involved, what each of them wants, what has been tried or settled, what is still open, and '
              + 'any names, numbers or times that were said. Someone reading it in an hour with nothing else '
              + 'in front of them should be able to act on it; a memory compressed to a phrase is worse than '
              + 'none. People as <@ID>, channels as <#ID>, dates absolute and written day.month.year like '
              + '"10.9.2026 18:00".',
          },
          channelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'The channels this was said in — the digits out of each <#id>.',
          },
          messageIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'The messages it came from, so it keeps its sources if it is ever kept for good.',
          },
          lifespan: {
            type: 'integer',
            description: 'How many messages it should live for. Leave it out for the usual.',
          },
        },
        required: ['text'],
      },
      handler(args, ctx) {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return { remembered: false, reason: 'The memory text was empty.' };

        const config = readConfig(ctx);
        const lifespan =
          typeof args.lifespan === 'number' && Number.isInteger(args.lifespan) && args.lifespan > 0
            ? Math.min(config.maxLifespan, args.lifespan)
            : config.defaultLifespan;

        const now = Date.now();
        const id = createMemory(
          open(ctx.database),
          {
            text,
            remaining: lifespan,
            lifespan,
            messageIds: JSON.stringify(stringIds(args.messageIds)),
            createdAt: now,
            updatedAt: now,
          },
          stringIds(args.channelIds),
        );
        console.log(`[rolling-memory] remembered ${id}: ${text.slice(0, 80)}`);
        return { remembered: true, id };
      },
    },
    {
      name: 'refresh',
      description:
        'Put memories back to full life because they are still going. Pass every id still relevant in one call. '
        + 'Refreshing costs nothing and forgetting something people are still talking about costs a lot.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'integer' }, description: 'The memory ids, as shown to you.' },
          channelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optionally, a channel these have now also come up in.',
          },
        },
        required: ['ids'],
      },
      handler(args, ctx) {
        const db = open(ctx.database);
        const ids = numericIds(args.ids);
        const refreshed = refreshMemories(db, ids, Date.now());
        for (const id of ids) linkChannels(db, id, stringIds(args.channelIds));
        return { refreshed };
      },
    },
    {
      name: 'revise',
      description:
        'Correct or add a small detail to a memory you already hold — they said six, now they say eight; you '
        + 'learn the name of the thing they are arguing about; somebody else joins the same thread. Only for '
        + 'when the memory is otherwise still true. A change of subject is not a revision: if what you would '
        + 'write is mostly new words, call remember instead and leave this one alone, or you will destroy what '
        + 'it recorded.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The memory id, as shown to you.' },
          text: { type: 'string', description: 'What it should say now. Same rules as remembering one.' },
        },
        required: ['id', 'text'],
      },
      handler(args, ctx) {
        const id = typeof args.id === 'number' ? args.id : Number.NaN;
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!Number.isInteger(id) || !text) return { revised: false, reason: 'Needs a memory id and some text.' };

        const db = open(ctx.database);
        const existing = listMemories(db).find((memory) => memory.id === id);
        if (!existing) return { revised: false, reason: `There is no memory ${id}.` };

        // Refused rather than trusted. Told to prefer revising, the model
        // rewrote one row every time the conversation drifted, so a whole
        // afternoon ended up as a single memory describing the last five
        // minutes. A correction keeps nearly all of what was there; a rewrite
        // does not, and this is the difference measured rather than asked for.
        const surviving = survivingFraction(existing.text, text);
        if (surviving < MIN_SURVIVING_FRACTION) {
          console.log(`[rolling-memory] refused a rewrite of ${id} (${Math.round(surviving * 100)}% kept)`);
          return {
            revised: false,
            reason:
              'That is a rewrite, not a revision — almost nothing of the memory you are editing survives in it, '
              + 'so the conversation has moved to a different subject. Call rolling_memory__remember with this '
              + 'text instead and leave the existing memory alone.',
          };
        }

        const revised = reviseMemory(db, id, text, Date.now());
        if (revised) console.log(`[rolling-memory] revised ${id}: ${text.slice(0, 80)}`);
        return { revised };
      },
    },
    {
      name: 'forget',
      description:
        'Drop memories that are genuinely over — the argument ended, they came back, the plan happened. '
        + 'Do not use it on something merely quiet; that fades on its own.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'integer' }, description: 'The memory ids, as shown to you.' },
        },
        required: ['ids'],
      },
      handler(args, ctx) {
        const ids = numericIds(args.ids);
        const forgotten = deleteMemories(open(ctx.database), ids);
        if (forgotten > 0) console.log(`[rolling-memory] forgot ${ids.join(', ')}`);
        return { forgotten };
      },
    },
  ],

  configSchema: [
    {
      name: 'capacity',
      label: 'Capacity',
      type: 'number',
      min: 1,
      max: 200,
      step: 1,
      description: 'How many memories may be held at once. Going over runs a compaction pass on the next reply.',
    },
    {
      name: 'compactTo',
      label: 'Compact down to',
      type: 'number',
      min: 1,
      max: 200,
      step: 1,
      description: 'How many compaction leaves behind. Kept below capacity, or it would run again immediately.',
    },
    {
      name: 'defaultLifespan',
      label: 'Default lifespan',
      type: 'number',
      min: 1,
      max: 5000,
      step: 1,
      description: 'How many messages a new memory lives for. Counted in messages, not minutes, so a quiet channel does not forget — but a busy one gets through them quickly, so this wants to be generous.',
    },
    {
      name: 'maxLifespan',
      label: 'Maximum lifespan',
      type: 'number',
      min: 1,
      max: 5000,
      step: 1,
      description: 'Ceiling on a lifespan the model asks for, so nothing becomes permanent by the back door.',
    },
  ] satisfies PluginField[],

  pages: [
    {
      id: 'memories',
      title: 'Memories',
      description: 'What the bot is holding in mind right now, freshest first.',

      render({ database }, { page, pageSize, query }) {
        const memories = listMemories(open(database));
        const needle = query.trim().toLowerCase();
        const matched = needle ? memories.filter((memory) => memory.text.toLowerCase().includes(needle)) : memories;

        const start = (page - 1) * pageSize;
        const shown: PluginPageRow[] = matched.slice(start, start + pageSize).map((memory) => ({
          id: String(memory.id),
          cells: {
            text: { kind: 'text', text: memory.text },
            // The channel a memory belongs to is the first it was linked to;
            // the rest are in the text where the model wrote them.
            channel: memory.channelIds[0]
              ? { kind: 'channel', id: memory.channelIds[0] }
              : { kind: 'text', text: '—', tone: 'muted' },
            life: {
              kind: 'meter',
              value: score(memory),
              label: `${Math.max(0, memory.remaining)}/${memory.lifespan}`,
            },
            updatedAt: { kind: 'time', at: memory.updatedAt },
          },
          actions: [
            { actionId: 'forget', label: 'Forget', tone: 'destructive' },
          ],
        }));

        return {
          columns: [
            { key: 'text', label: 'Memory' },
            { key: 'channel', label: 'Channel', secondary: true },
            { key: 'life', label: 'Life left', align: 'right' },
            { key: 'updatedAt', label: 'Last touched', align: 'right', secondary: true },
          ],
          rows: shown,
          total: matched.length,
          searchable: true,
          header: [
            {
              type: 'text',
              tone: 'muted',
              text:
                'Life left falls with every message the bot sees, so a thread nobody comes back to fades on its '
                + 'own. When it reaches zero the memory is offered to the model, which decides whether it is worth '
                + 'keeping as a permanent fact before it goes.',
            },
            {
              type: 'button',
              actionId: 'forget-all',
              label: 'Forget everything',
              tone: 'destructive',
              confirm: 'Every rolling memory will be deleted. Stored facts are untouched. This cannot be undone.',
            },
          ],
          emptyMessage: needle
            ? 'Nothing held matches that.'
            : 'Nothing held right now. Memories appear once the bot decides a conversation is worth keeping track of.',
        };
      },

      // An empty rowId is the header button; anything else is one memory's row.
      action(actionId, rowId, { database }) {
        if (actionId === 'forget-all') {
          clearAll(open(database));
          return { tone: 'success', message: 'Every rolling memory has been cleared.' };
        }
        if (actionId !== 'forget') return { tone: 'error', message: 'Unknown action.' };
        const id = Number.parseInt(rowId, 10);
        if (!Number.isInteger(id)) return { tone: 'error', message: 'That is not a memory id.' };
        return deleteMemories(open(database), [id]) > 0
          ? { tone: 'success', message: `Memory ${id} is gone.` }
          : { tone: 'error', message: `There is no memory ${id}.` };
      },
    },
  ],

};

export default plugin;
