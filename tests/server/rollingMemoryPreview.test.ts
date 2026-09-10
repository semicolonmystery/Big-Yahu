import { describe, expect, it } from 'vitest';
import { memoryPreview } from '../../src/server/plugins/bundled/rolling-memory/index';

const MENTION = '<@500000000000000001>';

describe('the table preview of a rolling memory', () => {
  it('leaves a memory that already fits alone', () => {
    expect(memoryPreview('Short enough to read in place')).toBeUndefined();
  });

  it('collapses the newlines a paragraph memory is written with', () => {
    const preview = memoryPreview(`First line.\n\n   Second line.\n${'padding '.repeat(30)}`);
    expect(preview).toContain('First line. Second line.');
    expect(preview).not.toContain('\n');
  });

  it('cuts to roughly a cell and marks that there is more', () => {
    const preview = memoryPreview('word '.repeat(200));
    expect(preview?.endsWith('…')).toBe(true);
    expect(preview!.length).toBeLessThanOrEqual(121);
  });

  it('never splits a mention into broken markup', () => {
    // Walk the mention across the cut so it lands either side of it and on it.
    for (let pad = 90; pad <= 130; pad += 1) {
      const preview = memoryPreview(`${'x'.repeat(pad)} ${MENTION} and then a great deal more text after it`);
      expect(preview).toBeDefined();
      // Either the whole mention survives or none of it does — never a fragment.
      const fragments = preview!.match(/<[@#][!&]?\d*/g) ?? [];
      for (const fragment of fragments) {
        expect(preview).toContain(MENTION);
        expect(fragment).toBe('<@500000000000000001');
      }
    }
  });

  it('still cuts a memory with no space to cut on', () => {
    const preview = memoryPreview('y'.repeat(400));
    expect(preview?.endsWith('…')).toBe(true);
    expect(preview!.length).toBeLessThanOrEqual(121);
  });
});
