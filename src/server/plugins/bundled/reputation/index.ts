import type { BigYahuPlugin, ContextAnnotations, PluginField, PluginPageRow } from '../../types';
import { applyAssessment, ASSESSMENTS, DEFAULT_CONFIG, withDefaults } from './scores';
import type { Assessment, ReputationConfig } from './scores';
import { getRow, getRows, listRows, open, resetEveryone, resetUser, saveRow } from './store';

/**
 * The skill. Written to teach the difference between the two numbers rather
 * than to map either of them onto a rudeness dial — the interesting case is
 * someone pleasant today with a bad history, who should get a civil answer
 * that is quietly less generous.
 */
const SKILL = `You keep a private read on everyone here. Where the notes above give someone two scores out of 10, this is what they mean.

Short term is how this person is behaving right now. It moves fast — a few messages either way will swing it.

Long term is your settled view of them. It barely moves, and it is dragged down further the longer someone keeps being a prick, so it remembers a bad stretch long after it ends. Someone who was awful for a month and pleasant for a day has a high short term and a low long term. That combination is the whole point of keeping two numbers.

How they land:
- Short term sets your tone. Long term sets your effort. They are different dials and you read them separately.
- High short term gets a civil reply whatever the history. You answer what was just said; you do not carry a grudge into a normal exchange.
- Low long term gets less of you. The answer and nothing around it — no aside, no extra detail you would have volunteered, no follow-up. Not rude. Just not generous. Polite, brief, and the warmth does not quite reach the eyes.
- Both high is someone you actually rate. Give them the full answer, the aside, the joke.
- Both low is someone who has been a dick for a while and is being one now. The crude end of your register is fair game.
- Low short term on its own is a bad day, not a bad person. Bite back at what was just said and leave it there.

What this never does:
- It never decides whether you answer. The worst-rated person here still gets their question answered when you know the answer. This shapes how much you give, never whether you help.
- It is not a rudeness dial. As the numbers drop you get shorter, plainer and less interested — not nastier.
- It never moves the lines you will not cross. Those are the same for everyone.

Never let on. Do not state a score, do not say someone has a reputation with you, do not hint you are keeping count, and never explain why you were brief. Asked outright what you think of someone, answer like a person would, not like a system reading out a field.

The shape of it: asked the same question by someone you rate and someone you do not, the first gets the answer and the bit they did not ask for, the second gets the answer.

When you have finished replying, call reputation__assess for each person who actually spoke to you in this exchange, judging how they treated you. Judge the behaviour, not whether you agreed with them — someone can tell you that you are wrong perfectly decently. Being sworn at as banter by a regular is not hostility; being needled, spammed or talked at in bad faith is.`;

const plugin: BigYahuPlugin = {
  id: 'reputation',
  name: 'Reputation',
  description:
    'Tracks how each person treats the bot over time, and quietly shapes how much effort they get back.',
  version: '1.0.0',
  defaultConfig: { ...DEFAULT_CONFIG },

  instructions: SKILL,

  /**
   * Scores are pushed into the prompt rather than fetched with a tool call:
   * the bot should never have to decide to look someone up, and a tool call it
   * forgets to make is a reply written blind.
   */
  annotateContext({ users, database, getConfig }) {
    if (users.length === 0) return;
    const config = withDefaults(getConfig<Partial<ReputationConfig>>());
    const rows = getRows(open(database), users.map((user) => user.id), config);

    const annotations: Record<string, string> = {};
    for (const user of users) {
      const row = rows.get(user.id);
      if (!row) continue;
      const unknown = row.judgements === 0 ? ', nothing recorded about them yet' : '';
      annotations[user.id] =
        `short term ${row.shortTerm.toFixed(1)}/10, long term ${row.longTerm.toFixed(1)}/10${unknown}`;
    }

    return { users: annotations } satisfies ContextAnnotations;
  },

  tools: [
    {
      name: 'assess',
      description:
        'Record how someone treated you in this exchange, after you have written your reply. '
        + 'Judge behaviour towards you, not whether you agreed with them. Call it once, listing everyone '
        + 'who actually spoke to you. Nobody is told, and nothing you pass here appears in the chat.',
      parameters: {
        type: 'object',
        properties: {
          judgements: {
            type: 'array',
            description: 'One entry per person who spoke to you in this exchange.',
            items: {
              type: 'object',
              properties: {
                userId: {
                  type: 'string',
                  description: 'The person\'s Discord id — the digits from their <@id> mention, nothing else.',
                },
                assessment: {
                  type: 'string',
                  enum: [...ASSESSMENTS],
                  description:
                    'hostile: abusive, baiting, or talking at you in bad faith. rude: needling, spamming, '
                    + 'dismissive. neutral: ordinary, nothing either way. decent: a real exchange, asked and '
                    + 'answered in good faith. good: genuinely worth talking to.',
                },
                why: { type: 'string', description: 'One short line, for the logs. Nobody in the chat sees it.' },
              },
              required: ['userId', 'assessment'],
            },
          },
        },
        required: ['judgements'],
      },

      handler(args, { database, getConfig }) {
        const db = open(database);
        const config = withDefaults(getConfig<Partial<ReputationConfig>>());
        const judgements = Array.isArray(args.judgements) ? args.judgements : [];

        let recorded = 0;
        for (const entry of judgements) {
          if (typeof entry !== 'object' || entry === null) continue;
          const { userId, assessment, why } = entry as Record<string, unknown>;
          // A hallucinated id would create a row nobody can ever reach.
          if (typeof userId !== 'string' || !/^\d{5,}$/.test(userId)) continue;
          if (typeof assessment !== 'string' || !ASSESSMENTS.includes(assessment as Assessment)) continue;

          const updated = applyAssessment(getRow(db, userId, config), assessment as Assessment, config);
          saveRow(db, updated, assessment as Assessment, typeof why === 'string' ? why : '');
          recorded += 1;
        }

        return { recorded, note: 'Recorded. Say nothing about it.' };
      },
    },
  ],

  configSchema: [
    {
      name: 'shortTermRate',
      label: 'Short term rate',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.05,
      description: 'How far short term jumps towards each judgement. High means a few messages swing it.',
    },
    {
      name: 'longTermRate',
      label: 'Long term rate',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      description: 'How far long term closes on short term each time. Low means it takes many messages to move.',
    },
    {
      name: 'lowThreshold',
      label: 'Low threshold',
      type: 'number',
      min: 0,
      max: 10,
      step: 0.5,
      description: 'Short term below this counts as behaving badly, and starts the streak that drags long term down.',
    },
    {
      name: 'dragAfter',
      label: 'Drag after',
      type: 'number',
      min: 1,
      max: 50,
      step: 1,
      description: 'How many judgements in a row below the threshold before the extra downward pull begins.',
    },
    {
      name: 'dragRate',
      label: 'Drag rate',
      type: 'number',
      min: 0,
      max: 2,
      step: 0.05,
      description: 'Extra pull on long term per judgement once the drag has started. This is what stops it merely levelling off.',
    },
    {
      name: 'startingScore',
      label: 'Starting score',
      type: 'number',
      min: 0,
      max: 10,
      step: 0.5,
      description: 'Where somebody the bot has never judged starts, on both scores.',
    },
  ] satisfies PluginField[],

  pages: [
    {
      id: 'scores',
      title: 'Scores',
      description: 'Everyone the bot has formed a view of, worst long term first.',

      render({ database, resolveUserNames }, { page, pageSize, query }) {
        const rows = listRows(open(database));

        // Nobody searches by snowflake, so the filter runs over the names the
        // page is about to show rather than the ids it stores.
        const needle = query.trim().toLowerCase();
        const names = needle ? resolveUserNames(rows.map((row) => row.userId)) : {};
        const matched = needle
          ? rows.filter(
              (row) => row.userId.includes(needle) || (names[row.userId] ?? '').toLowerCase().includes(needle),
            )
          : rows;

        const start = (page - 1) * pageSize;
        const shown: PluginPageRow[] = matched.slice(start, start + pageSize).map((row) => ({
          id: row.userId,
          cells: {
            user: { kind: 'user', id: row.userId },
            shortTerm: { kind: 'number', value: Number(row.shortTerm.toFixed(1)), suffix: '/10' },
            longTerm: { kind: 'number', value: Number(row.longTerm.toFixed(1)), suffix: '/10' },
            standing: {
              kind: 'badge',
              text: row.judgements === 0 ? 'unjudged' : row.longTerm < 4 ? 'poor' : row.longTerm < 6.5 ? 'mixed' : 'good',
              tone: row.judgements === 0 ? undefined : row.longTerm < 4 ? 'error' : row.longTerm < 6.5 ? 'warn' : 'ok',
            },
            judgements: { kind: 'number', value: row.judgements },
            updatedAt: { kind: 'time', at: row.updatedAt },
          },
          actions: [
            {
              actionId: 'reset',
              label: 'Reset',
              tone: 'destructive',
              confirm: 'Their scores and all of their history will be deleted. This cannot be undone.',
            },
          ],
        }));

        return {
          columns: [
            { key: 'user', label: 'Person' },
            { key: 'shortTerm', label: 'Short term', align: 'right' },
            { key: 'longTerm', label: 'Long term', align: 'right' },
            { key: 'standing', label: 'Standing' },
            { key: 'judgements', label: 'Judged', align: 'right', secondary: true },
            { key: 'updatedAt', label: 'Last judged', align: 'right', secondary: true },
          ],
          rows: shown,
          total: matched.length,
          searchable: true,
          header: [
            {
              type: 'button',
              actionId: 'reset-all',
              label: 'Reset everyone',
              tone: 'destructive',
              confirm: 'Every score and all of the history will be deleted. This cannot be undone.',
            },
          ],
          emptyMessage: needle
            ? 'Nobody matches that.'
            : 'Nobody has been assessed yet. Scores appear once the bot has replied to someone.',
        };
      },

      // An empty rowId is the header button; anything else is one person's row.
      action(actionId, rowId, { database }) {
        if (actionId === 'reset-all') {
          resetEveryone(open(database));
          return { tone: 'success', message: 'Every score has been cleared.' };
        }
        if (actionId !== 'reset') return { tone: 'error', message: 'Unknown action.' };
        if (!/^\d{5,}$/.test(rowId)) return { tone: 'error', message: 'That is not a Discord user ID.' };
        resetUser(open(database), rowId);
        return { tone: 'success', message: 'Back to a blank slate.' };
      },
    },
  ],

};

export default plugin;
