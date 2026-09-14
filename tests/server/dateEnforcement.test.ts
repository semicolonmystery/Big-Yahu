import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  structured: vi.fn(async (_task: string, _request: { system: string; user: string; schema: unknown }): Promise<unknown> => ({ facts: [] })),
}));
vi.mock('../../src/server/ai/structured', () => ({ structured: state.structured }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => ({ timezone: 'Europe/Prague' }) }));

import { hasUnresolvedRelativeDate, resolveRelativeDates } from '../../src/server/ai/dateEnforcement';

beforeEach(() => {
  vi.clearAllMocks();
  state.structured.mockResolvedValue({ facts: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(state.structured).not.toHaveBeenCalled();
  });

  it('anchors the correction to each fact timestamp in the configured timezone, on the date repair list', async () => {
    state.structured.mockResolvedValueOnce({ facts: [{ index: 0, text: 'Meeting on 11.9.2026.' }] });
    const result = await resolveRelativeDates([{ text: 'Meeting tomorrow.', anchor: Date.parse('2026-09-09T23:30:00Z') }]);
    expect(result).toEqual(['Meeting on 11.9.2026.']);
    expect(state.structured).toHaveBeenCalledWith('dateRepair', expect.objectContaining({
      user: expect.stringContaining('10 September 2026'), schema: expect.any(Object),
    }));
    const [, request] = state.structured.mock.calls[0];
    expect(request.user).toContain('01:30');
    // The time travels with the facts, so the instruction stays cacheable.
    expect(request.user).toContain('Right now it is');
    expect(request.system).not.toContain('Right now it is');
  });

  it('uses answer indices rather than answer order, and ignores entries that make no sense', async () => {
    state.structured.mockResolvedValueOnce({ facts: [
      { index: 1, text: '  Second on 12.9.2026.  ' },
      { index: -1, text: 'Bad' }, { index: 2, text: 'Bad' }, { index: '0', text: 'Bad' },
      { index: 0.5, text: 'Bad' }, { index: 0, text: '  ' }, { index: 0, text: 123 },
    ] });
    expect(await resolveRelativeDates([{ text: 'First tomorrow.', anchor: 100 }, { text: 'Second next week.', anchor: 200 }]))
      .toEqual(['First tomorrow.', 'Second on 12.9.2026.']);
  });

  it.each([{ facts: {} }, {}, null])('keeps the originals when the answer is unusable: %j', async (answer) => {
    state.structured.mockResolvedValueOnce(answer);
    expect(await resolveRelativeDates([{ text: 'Meeting tomorrow.', anchor: 100 }])).toEqual(['Meeting tomorrow.']);
  });

  it('keeps the originals when no model answers', async () => {
    state.structured.mockRejectedValueOnce(new Error('service unavailable'));
    expect(await resolveRelativeDates([{ text: 'Meeting tomorrow.', anchor: 100 }])).toEqual(['Meeting tomorrow.']);
  });
});
