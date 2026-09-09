import { describe, expect, it } from 'vitest';
import { hasRelativeDate, normalise } from '../../src/server/ai/relativeDates';

describe('relative date detection', () => {
  it('normalizes accents, casing and punctuation from chat', () => {
    expect(normalise('  ZÍTRA!! V PÁTEK  ')).toBe('zitra v patek');
  });

  it.each([
    'Tomorrow at 9', 'tommorow at 9', 'yestrday', 'tmrw', 'Tonight',
    'zítra v 9', 'zejta v 9', 'zítřejší plán', 'pozítří', 'včerejší schůzka', 'zajtra', 'dnešní zápas',
    'next Friday', 'within an hour', '3 days ago', 'za tejden', 'za 3 dny', 'před třemi dny',
    'příští pátek', 'budúci týždeň', 'on Friday', 'v pátek',
  ])('detects an unresolved date in %s', (text) => {
    expect(hasRelativeDate(text)).toBe(true);
  });

  it.each([
    '', 'Alice enjoys music.', '<@123> owns 3 dogs.',
    'The meeting is on Friday 11.9.2026.', 'The meeting is on Friday 2026-09-11.',
    'The meeting is on Friday 11 September 2026.',
  ])('does not flag an already absolute or timeless fact: %s', (text) => {
    expect(hasRelativeDate(text)).toBe(false);
  });

  it('still detects a strong relative expression alongside an absolute date', () => {
    expect(hasRelativeDate('The meeting was on Friday 11.9.2026 and resumes tomorrow.')).toBe(true);
  });

  it('detects a meeting moved to a bare weekday', () => {
    expect(hasRelativeDate('The meeting moved to Friday.')).toBe(true);
  });
});
