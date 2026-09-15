import { describe, expect, it } from 'vitest';
import {
  cleanupSchemaFor,
  deleteFactDeclaration,
  extractionSchemaFor,
  listPeopleDeclaration,
  readChannelDeclaration,
  readHistoryDeclaration,
  replyToDeclaration,
  saveFactDeclarationFor,
  searchFactsDeclarationFor,
  topicSchemaFor,
} from '../../src/server/ai/schemas';
import { ANY_FACT_TYPE } from '../../src/shared/factTypes';

const TYPES = ['rule', 'message', 'info'];

/** Everything the model is ever handed, with a type list and without one. */
const shapes: Array<[string, unknown]> = [
  ['extraction schema', extractionSchemaFor(TYPES)],
  ['extraction schema, no types defined', extractionSchemaFor([])],
  ['topic schema', topicSchemaFor(TYPES)],
  ['topic schema, no types defined', topicSchemaFor([])],
  ['cleanup schema', cleanupSchemaFor(TYPES)],
  ['read_history', readHistoryDeclaration],
  ['search_facts', searchFactsDeclarationFor(TYPES)],
  ['search_facts, no types defined', searchFactsDeclarationFor([])],
  ['list_people', listPeopleDeclaration],
  ['read_channel', readChannelDeclaration],
  ['reply_to', replyToDeclaration],
  ['delete_fact', deleteFactDeclaration],
  ['save_fact', saveFactDeclarationFor(TYPES)],
];

function enumsIn(node: unknown, path = ''): Array<{ path: string; values: unknown[] }> {
  if (Array.isArray(node)) return node.flatMap((entry, index) => enumsIn(entry, `${path}[${index}]`));
  if (typeof node !== 'object' || node === null) return [];
  const found: Array<{ path: string; values: unknown[] }> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'enum' && Array.isArray(value)) found.push({ path: `${path}.enum`, values: value });
    else found.push(...enumsIn(value, `${path}.${key}`));
  }
  return found;
}

describe('what the model is handed', () => {
  // Google refuses an empty enum member outright — "enum[0]: cannot be empty" —
  // and it is a 400 on the tool list, so it takes down every reply rather than
  // one call. "Search everything" is a word now, and this is the net under the
  // next person who reaches for the empty string as a sentinel.
  it.each(shapes)('%s has no empty enum member', (_name, shape) => {
    for (const { path, values } of enumsIn(shape)) {
      for (const value of values) {
        expect(typeof value === 'string' && value.length > 0, `${path} held ${JSON.stringify(value)}`).toBe(true);
      }
    }
  });

  it.each(shapes)('%s names no enum value twice', (_name, shape) => {
    for (const { path, values } of enumsIn(shape)) {
      expect(new Set(values).size, path).toBe(values.length);
    }
  });

  it('offers "search everything" as a value rather than as an absence', () => {
    const tool = searchFactsDeclarationFor(TYPES);
    const properties = (tool.parameters as { properties: Record<string, any> }).properties;
    const values = properties.searches.items.properties.type.enum as string[];
    expect(values[0]).toBe(ANY_FACT_TYPE);
    expect(values).toEqual([ANY_FACT_TYPE, ...TYPES]);
  });

  // With no types defined there is nothing to choose between, and an enum of one
  // sentinel would be a field that can only hold a value meaning "no filter".
  it('leaves the enum off entirely when the operator has defined no types', () => {
    const tool = searchFactsDeclarationFor([]);
    const properties = (tool.parameters as { properties: Record<string, any> }).properties;
    expect(properties.searches.items.properties.type.enum).toBeUndefined();
  });
});
