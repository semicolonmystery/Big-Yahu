import { describe, expect, it } from 'vitest';
import {
  MAX_PROMPT_BYTES,
  PROMPTS,
  PROMPT_IDS,
  describesOldFormat,
  promptRejection,
} from '../../src/server/ai/prompts/registry';

describe('what a prompt may be replaced with', () => {
  it('ships defaults that satisfy their own rules', () => {
    for (const id of PROMPT_IDS) {
      expect(promptRejection(id, PROMPTS[id].fallback)).toBeNull();
    }
  });

  it('takes whatever an operator writes, braces and all', () => {
    // Nothing is substituted any more, so `{{whatever}}` is simply text. It is
    // their prompt; refusing it would be the panel being clever for no reason.
    expect(promptRejection('reply', 'answer people, briefly')).toBeNull();
    expect(promptRejection('reply', 'answer people in {{language}}')).toBeNull();
    expect(promptRejection('factExtraction', 'remember what matters {{now}}')).toBeNull();
  });

  it('refuses an empty prompt and one past the size cap', () => {
    expect(promptRejection('topicExtraction', '   ')).toContain('cannot be empty');
    expect(promptRejection('topicExtraction', 'x'.repeat(MAX_PROMPT_BYTES + 1))).toContain('KB');
  });

});

describe('a prompt written for the old transcript', () => {
  it('recognises the markers and the time placeholder that no longer exist', () => {
    for (const body of [
      'Lines are tagged [id=...].',
      'A reply carries [replying to id=...].',
      'Memories look like [factId=abc].',
      'A line marked [image not shown] had a picture.',
      'Right now it is {{now}}.',
    ]) expect(describesOldFormat(body)).toBe(true);
  });

  it('leaves what ships, and anything written for the material, alone', () => {
    for (const id of PROMPT_IDS) expect(describesOldFormat(PROMPTS[id].fallback)).toBe(false);
    expect(describesOldFormat('Read `messages`, follow `replyTo`, reply in {{language}}.')).toBe(false);
  });
});

describe('what ships', () => {
  it('asks for no substitution at all, so every call sends the same bytes', () => {
    for (const id of PROMPT_IDS) expect(PROMPTS[id].fallback).not.toContain('{{');
  });

  it('never hands the model the server id: it names a message and the bot links it', () => {
    expect(PROMPTS.reply.fallback).not.toContain('discord.com/channels');
    expect(PROMPTS.reply.fallback).toContain('<link:MESSAGE_ID>');
  });
});
