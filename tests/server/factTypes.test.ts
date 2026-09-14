import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/server/db/client';
import { factTypes, settings } from '../../src/server/db/schema';
import {
  FactTypeError,
  addFactType,
  duplicateDistanceFor,
  factTypesForModel,
  knownTypes,
  listFactTypes,
  removeFactType,
  resetBuiltInFactTypes,
  searchLimitsFor,
  updateFactType,
} from '../../src/server/db/repositories/factTypesRepo';
import { updateSettings } from '../../src/server/db/repositories/settingsRepo';
import { BUILT_IN_FACT_TYPES } from '../../src/shared/factTypes';
import { FACT_EXTRACTION_DEFAULT, REPLY_DEFAULT } from '../../src/server/ai/prompts/systemInstructions';

beforeEach(() => {
  db.delete(factTypes).run();
  db.delete(settings).run();
});

describe('the shipped types', () => {
  it('seed themselves on first read, with a description the model can act on', () => {
    const types = listFactTypes();
    expect(types.map((type) => type.id)).toEqual(BUILT_IN_FACT_TYPES.map((type) => type.id));
    expect(types.every((type) => type.builtIn)).toBe(true);
    // The description is the working part: it is what the model reads to sort a
    // fact into a type and to decide which type to search.
    expect(types.every((type) => type.description.length > 40)).toBe(true);
  });

  it('copy the global fact settings, so the globals are the seed and not a second set of numbers', () => {
    updateSettings({ duplicateDistance: 31, factSearchTopK: 9 });
    const rule = listFactTypes().find((type) => type.id === 'rule')!;
    expect(rule).toMatchObject({ duplicateDistance: 31, factSearchTopK: 9 });
  });

  it('ship message with dedupe off, because near-identical records are the point of it', () => {
    updateSettings({ duplicateDistance: 31 });
    expect(listFactTypes().find((type) => type.id === 'message')!.duplicateDistance).toBe(0);
  });

  it('only reach the model as an id and a description', () => {
    expect(factTypesForModel()[0]).toEqual({ id: 'rule', description: expect.any(String) });
  });
});

describe('the settings a candidate is judged by', () => {
  it('takes the tightest of a fact’s types, and off beats any number', () => {
    updateFactType('rule', { duplicateDistance: 40 });
    updateFactType('decision', { duplicateDistance: 20 });
    expect(duplicateDistanceFor(['rule'])).toBe(40);
    expect(duplicateDistanceFor(['rule', 'decision'])).toBe(20);
    // `message` ships at 0 and is on nearly everything, which is what usually decides.
    expect(duplicateDistanceFor(['rule', 'message'])).toBe(0);
  });

  it('falls back to the global for a fact with no types, or only types nobody defined', () => {
    updateSettings({ duplicateDistance: 27 });
    expect(duplicateDistanceFor(undefined)).toBe(27);
    expect(duplicateDistanceFor([])).toBe(27);
    expect(duplicateDistanceFor(['invented'])).toBe(27);
  });

  it('gives a search the named type’s budget, and the global when none is named', () => {
    updateSettings({ factSearchTopK: 8, factSearchMaxDistance: 50 });
    expect(searchLimitsFor('message')).toEqual({ topK: 12, maxDistance: 0.5 });
    expect(searchLimitsFor(undefined)).toEqual({ topK: 8, maxDistance: 0.5 });
  });
});

describe('types the operator owns', () => {
  it('adds one, seeded from the globals', () => {
    updateSettings({ duplicateDistance: 22 });
    const added = addFactType({ id: 'project', label: 'Project', description: 'An ongoing thing the server is doing.' });
    expect(added).toMatchObject({ id: 'project', builtIn: false, duplicateDistance: 22 });
    expect(listFactTypes().map((type) => type.id)).toContain('project');
  });

  it('refuses an id that would not survive a metadata value or a schema enum', () => {
    for (const id of ['1st', 'a b', '', 'a'.repeat(40), 'has.a.dot']) {
      expect(() => addFactType({ id, label: 'x', description: 'y' }), id).toThrow(FactTypeError);
    }
  });

  it('normalises the case of an id rather than refusing it', () => {
    expect(addFactType({ id: 'Project', label: 'Project', description: 'An ongoing thing.' }).id).toBe('project');
  });

  it('refuses a type with no description, because the model would have nothing to go on', () => {
    expect(() => addFactType({ id: 'project', label: 'Project', description: '  ' })).toThrow(FactTypeError);
  });

  it('refuses a second type with the same id', () => {
    addFactType({ id: 'project', label: 'Project', description: 'An ongoing thing.' });
    expect(() => addFactType({ id: 'project', label: 'Other', description: 'Something else.' })).toThrow(FactTypeError);
  });

  it('holds the numbers inside their bounds rather than refusing them', () => {
    const added = addFactType({
      id: 'project', label: 'Project', description: 'An ongoing thing.',
      duplicateDistance: -5, factSearchTopK: 900, factSearchMaxDistance: 9000,
    });
    expect(added).toMatchObject({ duplicateDistance: 0, factSearchTopK: 50, factSearchMaxDistance: 200 });
  });

  it('removes one it added but never one that ships', () => {
    addFactType({ id: 'project', label: 'Project', description: 'An ongoing thing.' });
    expect(removeFactType('project')).toBe(true);
    expect(removeFactType('project')).toBe(false);
    expect(() => removeFactType('rule')).toThrow(FactTypeError);
  });

  it('puts the shipped types back without touching what the operator added', () => {
    updateFactType('rule', { description: 'something else entirely' });
    addFactType({ id: 'project', label: 'Project', description: 'An ongoing thing.' });
    const after = resetBuiltInFactTypes();
    expect(after.find((type) => type.id === 'rule')!.description)
      .toBe(BUILT_IN_FACT_TYPES.find((type) => type.id === 'rule')!.description);
    expect(after.map((type) => type.id)).toContain('project');
  });
});

describe('what a model is allowed to claim', () => {
  it('keeps only ids that exist, so a made-up type cannot reach the store', () => {
    expect(knownTypes(['rule', 'invented', 'message'])).toEqual(['rule', 'message']);
    expect(knownTypes(['RULE', ' rule '])).toEqual(['rule']);
    expect(knownTypes(['rule', 'rule'])).toEqual(['rule']);
  });

  it('treats anything that is not a list of strings as no types at all', () => {
    for (const claimed of [undefined, null, 'rule', 42, {}, [1, 2]]) {
      expect(knownTypes(claimed)).toEqual([]);
    }
  });
});

// The regex that used to rewrite fuzzy dates is gone, so the prompts are the
// whole mechanism. These assert the rules are actually in the text both
// fact-writing sites read, not that a model obeys them.
describe('the rules both fact-writing prompts carry', () => {
  it.each([['fact extraction', FACT_EXTRACTION_DEFAULT], ['the reply', REPLY_DEFAULT]])(
    '%s says a date is only written when somebody said it', (_name, prompt) => {
      expect(prompt).toMatch(/only (write|say) when something happened/i);
      expect(prompt).toMatch(/matěj říkal že je teplej/);
      expect(prompt).toMatch(/invent/i);
    },
  );

  it.each([['fact extraction', FACT_EXTRACTION_DEFAULT], ['the reply', REPLY_DEFAULT]])(
    '%s still insists on day.month.year, now that nothing rewrites it afterwards', (_name, prompt) => {
      expect(prompt).toContain('day.month.year');
      expect(prompt).toMatch(/10\.9\.2026/);
    },
  );

  it.each([['fact extraction', FACT_EXTRACTION_DEFAULT], ['the reply', REPLY_DEFAULT]])(
    '%s points at the factTypes list rather than naming the types itself', (_name, prompt) => {
      expect(prompt).toContain('factTypes');
      expect(prompt).toMatch(/"message"/);
    },
  );
});
