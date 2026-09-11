import { describe, expect, it } from 'vitest';
import {
  MAX_PROMPT_BYTES,
  PROMPTS,
  PROMPT_IDS,
  placeholdersIn,
  promptRejection,
  renderPrompt,
} from '../../src/server/ai/prompts/registry';

describe('what a prompt may be replaced with', () => {
  it('ships defaults that satisfy their own rules', () => {
    for (const id of PROMPT_IDS) {
      expect(promptRejection(id, PROMPTS[id].fallback)).toBeNull();
    }
  });

  it('refuses a reply prompt that drops a placeholder it cannot do without', () => {
    // Without {{now}} the bot silently stops knowing the date, and every
    // relative date it resolves from then on is wrong.
    const withoutNow = PROMPTS.reply.fallback.replace('{{now}}', 'the current time');
    expect(promptRejection('reply', withoutNow)).toContain('{{now}}');

    const withoutGuild = PROMPTS.reply.fallback.replace('{{guildId}}', '123');
    expect(promptRejection('reply', withoutGuild)).toContain('{{guildId}}');
  });

  it('names every missing placeholder at once rather than one per attempt', () => {
    const rejection = promptRejection('reply', 'Say something. {{language}}');
    expect(rejection).toContain('{{now}}');
    expect(rejection).toContain('{{guildId}}');
  });

  it('refuses a placeholder nothing will ever replace', () => {
    const rejection = promptRejection('factExtraction', 'Read this. {{now}} {{nickname}}');
    expect(rejection).toContain('{{nickname}}');
  });

  it('refuses an empty prompt and one past the size cap', () => {
    expect(promptRejection('topicExtraction', '   ')).toContain('cannot be empty');
    expect(promptRejection('topicExtraction', 'x'.repeat(MAX_PROMPT_BYTES + 1))).toContain('KB');
  });

  it('asks for nothing the topic prompt does not substitute', () => {
    expect(promptRejection('topicExtraction', 'Work out the topic.')).toBeNull();
  });
});

describe('rendering a prompt', () => {
  it('substitutes every value and leaves nothing behind', () => {
    const rendered = renderPrompt(PROMPTS.reply.fallback, {
      now: '10.9.2026 21:00', language: 'Czech', guildId: '100000000000000001',
    });
    expect(rendered).toContain('10.9.2026 21:00');
    expect(rendered).toContain('discord.com/channels/100000000000000001/');
    expect(placeholdersIn(rendered)).toEqual([]);
  });

  it('gives the model exactly what was saved, with nothing appended', () => {
    const body = 'be nice {{now}} {{language}} {{guildId}}';
    expect(renderPrompt(body, { now: 'n', language: 'l', guildId: 'g' })).toBe('be nice n l g');
    expect(renderPrompt('Work it out.', {})).toBe('Work it out.');
  });

  it('leaves a placeholder it was given no value for alone rather than blanking it', () => {
    expect(renderPrompt('at {{now}} in {{language}}', { now: 'noon' })).toBe('at noon in {{language}}');
  });
});
