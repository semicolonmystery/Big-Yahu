import { DISCORD_MESSAGE_LIMIT, MAX_REPLY_PARTS } from '@shared/constants';

/**
 * A reply, as the messages it should actually be sent as.
 *
 * People type in bursts — a thought, send, another thought — and a model that
 * writes several lines is writing several messages. Sent as one block with
 * newlines in it, a long answer reads as a document somebody pasted rather than
 * as somebody talking.
 *
 * Every newline is a break, not only blank lines: a list written a line at a
 * time is somebody sending a line at a time. Runs of blank lines collapse, so
 * paragraph spacing does not produce empty messages.
 *
 * Bounded by `MAX_REPLY_PARTS`, because a model that answers with a long list
 * would otherwise post twenty times and meet Discord's rate limiter. Past the
 * cap the remainder is joined back onto the last part rather than dropped —
 * losing the end of an answer to a formatting rule would be worse than a
 * slightly long final message.
 *
 * Anything still over Discord's own limit is cut there, as it always was.
 */
export function replyParts(text: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const parts = lines.length <= MAX_REPLY_PARTS
    ? lines
    : [...lines.slice(0, MAX_REPLY_PARTS - 1), lines.slice(MAX_REPLY_PARTS - 1).join('\n')];

  return parts.map((part) => part.slice(0, DISCORD_MESSAGE_LIMIT)).filter((part) => part.length > 0);
}
