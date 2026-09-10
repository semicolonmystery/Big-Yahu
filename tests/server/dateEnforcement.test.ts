import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ generate: vi.fn(async () => ({ text: '{}' })) }));
vi.mock('../../src/server/ai/generate', () => ({ generate: state.generate }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => ({ timezone: 'Europe/Prague' }) }));

import { hasUnresolvedRelativeDate, resolveRelativeDates } from '../../src/server/ai/dateEnforcement';

beforeEach(() => {
  vi.clearAllMocks();
  state.generate.mockResolvedValue({ text: '{}' });
});

describe('fact date enforcement', () => {
  it.each([
    'Alice said "tomorrow".', 'Alice said “zítra”.', 'Alice typed `next Friday`.',
  ])('keeps quoted wording out of the unresolved-date detector: %s', (text) => {
    expect(hasUnresolvedRelativeDate(text)).toBe(false);
  });

  it('detects unresolved dates outside quotes', () => {
    expect(hasUnresolvedRelativeDate('Alice said "tomorrow" and the meeting moved to next Friday.')).toBe(true);
  });

  it('does no AI work for an empty correction batch', async () => {
    expect(await resolveRelativeDates([])).toEqual([]);
    expect(state.generate).not.toHaveBeenCalled();
  });

  it('anchors the correction to each fact timestamp in the configured timezone', async () => {
    state.generate.mockResolvedValueOnce({ text: '{"facts":[{"index":0,"text":"Meeting on 11.9.2026."}]}' });
    const result = await resolveRelativeDates([{ text: 'Meeting tomorrow.', anchor: Date.parse('2026-09-09T23:30:00Z') }]);
    expect(result).toEqual(['Meeting on 11.9.2026.']);
    expect(state.generate).toHaveBeenCalledWith(expect.stringContaining('10 September 2026'), expect.objectContaining({
      responseMimeType: 'application/json', responseSchema: expect.any(Object),
    }));
    expect(state.generate).toHaveBeenCalledWith(expect.stringContaining('01:30'), expect.any(Object));
  });

  it('uses response indices rather than response ordering and rejects invalid entries', async () => {
    state.generate.mockResolvedValueOnce({ text: JSON.stringify({ facts: [
      { index: 1, text: '  Second on 12.9.2026.  ' },
      { index: -1, text: 'Bad' }, { index: 2, text: 'Bad' }, { index: '0', text: 'Bad' },
      { index: 0.5, text: 'Bad' }, { index: 0, text: '  ' }, { index: 0, text: 123 },
    ] }) });
    expect(await resolveRelativeDates([{ text: 'First tomorrow.', anchor: 100 }, { text: 'Second next week.', anchor: 200 }]))
      .toEqual(['First tomorrow.', 'Second on 12.9.2026.']);
  });

  it.each(['not JSON', '{"facts":{}}', '{}'])('retains originals if output is unusable: %s', async (text) => {
    state.generate.mockResolvedValueOnce({ text });
    expect(await resolveRelativeDates([{ text: 'Meeting tomorrow.', anchor: 100 }])).toEqual(['Meeting tomorrow.']);
  });

  it('retains originals during a Gemini outage', async () => {
    state.generate.mockRejectedValueOnce(new Error('service unavailable'));
    expect(await resolveRelativeDates([{ text: 'Meeting tomorrow.', anchor: 100 }])).toEqual(['Meeting tomorrow.']);
  });
});
