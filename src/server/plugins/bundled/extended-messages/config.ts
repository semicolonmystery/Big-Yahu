/**
 * Every capability here has its own switch, because they are not the same risk.
 * Reading reactions off messages the bot already sees costs nothing and reveals
 * nothing; posting a poll writes into the channel; resolving who reacted spends
 * a Discord call per reaction.
 */
export interface ExtendedMessagesConfig {
  enablePolls: boolean;
  enableEmbeds: boolean;
  enableReactions: boolean;
  enableWhoReacted: boolean;
  enableReadPoll: boolean;
  /** The reaction list attached to the messages in every reply prompt. */
  enableReactionSummary: boolean;
  /** The state of a poll attached to the message carrying it, in every reply prompt. */
  enablePollSummary: boolean;
  /**
   * How many recent messages the one channel fetch reads. Zero skips that fetch
   * entirely, which switches off both the reaction list and the poll state.
   */
  reactionSummaryMessages: number;
  /** How many distinct reactions on one message who_reacted will resolve. */
  whoReactedMaxReactions: number;
  /** How many people who_reacted will name per reaction. */
  whoReactedMaxUsers: number;
  /** Whether read_poll names the people behind the votes at all. */
  enablePollVoters: boolean;
  /** How many of a poll's answers read_poll will resolve voters for. */
  readPollMaxAnswers: number;
  /** How many people read_poll will name per answer. */
  readPollMaxVoters: number;
  /** How many of these tools one reply may fire in total. */
  maxActionsPerReply: number;
}

/** The switches a tool can be gated on, one per tool. */
export type ExtendedMessagesFeature =
  'enablePolls' | 'enableEmbeds' | 'enableReactions' | 'enableWhoReacted' | 'enableReadPoll';

type NumericKey =
  | 'reactionSummaryMessages'
  | 'whoReactedMaxReactions'
  | 'whoReactedMaxUsers'
  | 'readPollMaxAnswers'
  | 'readPollMaxVoters'
  | 'maxActionsPerReply';

type BooleanKey = Exclude<keyof ExtendedMessagesConfig, NumericKey>;

export const DEFAULT_CONFIG: ExtendedMessagesConfig = {
  enablePolls: true,
  enableEmbeds: true,
  enableReactions: true,
  // On with the rest. Naming who reacted is still only telling people what the
  // channel already shows them, and it is the one with a cost, so it is capped
  // rather than held behind its own opt-in.
  enableWhoReacted: true,
  // Reading a poll back is the same kind of thing as reading reactions: it says
  // only what the channel already shows everybody. The cost is in the voters,
  // which have their own switch and their own two caps.
  enableReadPoll: true,
  enableReactionSummary: true,
  enablePollSummary: true,
  // Discord's own per-call maximum is 100. Forty is the recent conversation,
  // which is the part anybody reacts to.
  reactionSummaryMessages: 40,
  whoReactedMaxReactions: 5,
  whoReactedMaxUsers: 20,
  enablePollVoters: true,
  // Ten is Discord's own maximum number of answers, so five is half a full poll
  // — enough for the shape of the vote without ten calls for one question.
  readPollMaxAnswers: 5,
  readPollMaxVoters: 20,
  // Two is a poll and a reaction, or an embed and a reaction. Anything beyond
  // that in one reply is the model decorating rather than answering.
  maxActionsPerReply: 2,
};

/** Saved config predates new fields after an update, so defaults are merged every time it is read. */
export function withDefaults(config: Partial<ExtendedMessagesConfig>): ExtendedMessagesConfig {
  const boolean = (key: BooleanKey): boolean =>
    typeof config[key] === 'boolean' ? config[key] : DEFAULT_CONFIG[key];

  const whole = (key: NumericKey, min: number, max: number): number => {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIG[key];
    return Math.min(max, Math.max(min, Math.round(value)));
  };

  return {
    enablePolls: boolean('enablePolls'),
    enableEmbeds: boolean('enableEmbeds'),
    enableReactions: boolean('enableReactions'),
    enableWhoReacted: boolean('enableWhoReacted'),
    enableReadPoll: boolean('enableReadPoll'),
    enableReactionSummary: boolean('enableReactionSummary'),
    enablePollSummary: boolean('enablePollSummary'),
    // Zero is meaningful: it switches the extra fetch off without switching the
    // feature off, so an operator can measure what it costs them.
    reactionSummaryMessages: whole('reactionSummaryMessages', 0, 100),
    whoReactedMaxReactions: whole('whoReactedMaxReactions', 1, 20),
    // Discord's own per-call maximum for a reaction's voters.
    whoReactedMaxUsers: whole('whoReactedMaxUsers', 1, 100),
    enablePollVoters: boolean('enablePollVoters'),
    // Discord allows at most ten answers on a poll, so there is never an
    // eleventh to resolve.
    readPollMaxAnswers: whole('readPollMaxAnswers', 1, 10),
    // Discord's own per-call maximum for a poll answer's voters.
    readPollMaxVoters: whole('readPollMaxVoters', 1, 100),
    maxActionsPerReply: whole('maxActionsPerReply', 1, 10),
  };
}
