import { describe, expect, it } from 'vitest';
import { schemaViolation, type JsonSchema } from '../../src/server/ai/jsonSchema';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    count: { type: 'integer' },
    ok: { type: 'boolean' },
    mood: { type: 'string', enum: ['calm', 'heated'] },
    date: { type: 'string', pattern: '^(\\d{1,2}\\.\\d{1,2}\\.\\d{4})?$' },
    tags: { type: 'array', items: { type: 'string' } },
    nested: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
  },
  required: ['text', 'count', 'ok', 'mood', 'date', 'tags', 'nested'],
  additionalProperties: false,
};

const valid = { text: 'a', count: 1, ok: true, mood: 'calm', date: '3.10.2026', tags: ['x'], nested: { n: 1.5 } };

describe('holding an answer to its schema', () => {
  it('accepts an answer that fits, including an empty pattern-checked string', () => {
    expect(schemaViolation(schema, valid)).toBeNull();
    expect(schemaViolation(schema, { ...valid, date: '', tags: [] })).toBeNull();
  });

  const { text: _text, ...withoutText } = valid;

  it.each([
    ['an extra key', { ...valid, extra: 1 }, 'the answer has "extra", which is not in the schema'],
    ['a missing key', withoutText, 'the answer is missing "text"'],
    ['a fraction where a whole number belongs', { ...valid, count: 1.5 }, 'the answer.count must be a whole number'],
    ['a value outside the enum', { ...valid, mood: 'furious' }, 'the answer.mood must be one of "calm", "heated"'],
    ['a date in the wrong order', { ...valid, date: '2026-10-03' }, 'the answer.date must match'],
    ['a wrong type inside an array', { ...valid, tags: ['x', 2] }, 'the answer.tags[1] must be a string'],
    ['a nested object missing a key', { ...valid, nested: {} }, 'the answer.nested is missing "n"'],
    ['a non-finite number', { ...valid, nested: { n: Number.NaN } }, 'the answer.nested.n must be a number'],
    ['a string where true or false belongs', { ...valid, ok: 'yes' }, 'the answer.ok must be true or false'],
    ['an array where an object belongs', [], 'the answer must be an object'],
  ])('names the problem with %s, so it can be quoted back to the model', (_case, answer, problem) => {
    expect(schemaViolation(schema, answer)).toContain(problem);
  });
});
