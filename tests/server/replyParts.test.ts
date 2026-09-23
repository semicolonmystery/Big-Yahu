import { describe, expect, it } from 'vitest';
import { replyParts } from '../../src/server/bot/replyParts';
import { DISCORD_MESSAGE_LIMIT, MAX_REPLY_PARTS } from '../../src/shared/constants';

describe('sending a reply as several messages', () => {
  // People type in bursts. One block with newlines in it reads as a document
  // somebody pasted rather than as somebody talking.
  it('sends each line as its own message', () => {
    expect(replyParts('prvni vec\ndruha vec\ntreti vec')).toEqual(['prvni vec', 'druha vec', 'treti vec']);
  });

  it('collapses the blank lines between paragraphs rather than sending nothing', () => {
    expect(replyParts('odstavec jedna\n\n\nodstavec dva')).toEqual(['odstavec jedna', 'odstavec dva']);
  });

  it('leaves a single-line answer as one message', () => {
    expect(replyParts('jasně, tar -czf')).toEqual(['jasně, tar -czf']);
  });

  it('trims each part, so leading spaces do not survive as indentation', () => {
    expect(replyParts('  jedna  \n   dva')).toEqual(['jedna', 'dva']);
  });

  it('has nothing to send for an empty answer', () => {
    expect(replyParts('')).toEqual([]);
    expect(replyParts('\n\n  \n')).toEqual([]);
  });

  // A model answering with a long list would otherwise post twenty times and
  // meet Discord's rate limiter.
  it('joins the tail onto the last message rather than dropping it', () => {
    const lines = Array.from({ length: MAX_REPLY_PARTS + 4 }, (_, index) => `line ${index + 1}`);
    const parts = replyParts(lines.join('\n'));

    expect(parts).toHaveLength(MAX_REPLY_PARTS);
    expect(parts[MAX_REPLY_PARTS - 1]).toContain(`line ${lines.length}`);
    // Every line is still in there somewhere: losing the end of an answer to a
    // formatting rule is worse than one long final message.
    for (const line of lines) expect(parts.join('\n')).toContain(line);
  });

  it('still cuts a single line at Discord’s own limit', () => {
    const [part] = replyParts('x'.repeat(DISCORD_MESSAGE_LIMIT + 500));
    expect(part).toHaveLength(DISCORD_MESSAGE_LIMIT);
  });
});
