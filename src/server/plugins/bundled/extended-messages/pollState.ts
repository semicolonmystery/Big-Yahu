import type { PartialPollAnswer, Poll, PollAnswer } from 'discord.js';

/**
 * One poll, read back the way the model should read it.
 *
 * Shared by the two places a poll is reported: attached to its message in the
 * reply prompt (`messageState.ts`) and returned by `read_poll`. Same field names
 * in both, so the model is not learning the shape twice — `read_poll` only adds
 * the people behind the votes.
 */

/** One answer's standing. `people` is added by `read_poll`, never by the material. */
export interface PollAnswerState {
  /** Discord's own answer number, which is what identifies an answer with no text. */
  id: number;
  /** Absent when Discord gave the answer no text — an emoji-only option. Never the string "null". */
  text?: string;
  /** The character, or `name:id` for a custom emoji, matching how reactions are named here. */
  emoji?: string;
  votes: number;
}

export interface PollState {
  /** Absent only if Discord gave no question text, which a real poll does not. */
  question?: string;
  answers: PollAnswerState[];
  /**
   * Whether Discord says these counts are the final ones.
   *
   * Named for what the model has to decide — can I state this number as the
   * result — rather than after Discord's `results.is_finalized`. It is on every
   * payload, true or false, because a missing flag reads as "fine to assert".
   */
  voteCountsFinal: boolean;
  /** Only when people may pick more than one, so the counts can exceed the voters. */
  multipleChoice?: true;
  /** Only once voting is over. */
  closed?: true;
  /** When voting closes, ISO 8601, where Discord gave an expiry. */
  expiresAt?: string;
}

/**
 * A poll's state off a message that has already been fetched.
 *
 * Nothing here calls Discord. `message.poll` is built from the message payload
 * — `Message#_patch` constructs `Poll` from `data.poll`, counts included from
 * `data.poll.results.answer_counts` — so a poll read off a fetched message costs
 * no call of its own. Voters are the only part that does, and they are resolved
 * in `readPollTool.ts` behind their own switch.
 */
export function pollState(poll: Poll): PollState {
  const closed = poll.resultsFinalized
    || (poll.expiresTimestamp !== null && poll.expiresTimestamp <= Date.now());
  const question = typeof poll.question?.text === 'string' ? poll.question.text.trim() : '';
  return {
    ...(question ? { question } : {}),
    answers: [...poll.answers.values()].map(answerState),
    // Discord only promises precise counts once a poll has ended. Carried
    // whichever way it reads, so the model can say "so far" rather than stating
    // a moving number as the result.
    voteCountsFinal: poll.resultsFinalized === true,
    // `allowMultiselect` is typed boolean but patched to null on a payload that
    // omits it, so this is a true check rather than a falsy one.
    ...(poll.allowMultiselect === true ? { multipleChoice: true as const } : {}),
    ...(closed ? { closed: true as const } : {}),
    ...(poll.expiresTimestamp ? { expiresAt: new Date(poll.expiresTimestamp).toISOString() } : {}),
  };
}

/**
 * `text` is nullable on a full answer and always null on a partial one, so it is
 * left out rather than carried as null — a JSON `null` renders as the word and
 * the model reads an option literally called null. The answer id stays, which is
 * what identifies an emoji-only option.
 */
export function answerState(answer: PollAnswer | PartialPollAnswer): PollAnswerState {
  const text = typeof answer.text === 'string' ? answer.text.trim() : '';
  const emoji = pollEmojiLabel(answer);
  return {
    id: answer.id,
    ...(text ? { text } : {}),
    ...(emoji ? { emoji } : {}),
    votes: typeof answer.voteCount === 'number' ? answer.voteCount : 0,
  };
}

/**
 * How an answer's emoji is named: the same `name:id` or bare character the
 * reaction list uses, so one form of emoji is readable everywhere here.
 *
 * `PollAnswer#emoji` is a getter returning `GuildEmoji | Emoji | null`, and it
 * is null on a partial answer.
 */
function pollEmojiLabel(answer: PollAnswer | PartialPollAnswer): string | null {
  const emoji = answer.emoji;
  if (!emoji) return null;
  if (emoji.id) return `${emoji.name ?? 'emoji'}:${emoji.id}`;
  return emoji.name ?? null;
}
