/**
 * The part of JSON Schema the structured calls use, and a check against it.
 *
 * JSON mode guarantees JSON, not the shape of it, so every answer is held to
 * its schema here before anything reads it. Deliberately small: objects with
 * every property required and nothing extra, arrays, and plain values with an
 * optional enum or pattern. A schema needing more than that is a sign the
 * answer should be simpler.
 */
export type JsonSchema =
  | {
    type: 'object';
    properties: Record<string, JsonSchema>;
    required: readonly string[];
    additionalProperties: false;
    description?: string;
  }
  | { type: 'array'; items: JsonSchema; description?: string }
  | { type: 'string'; enum?: readonly string[]; pattern?: string; description?: string }
  | { type: 'integer' | 'number' | 'boolean'; description?: string };

/**
 * The first way `value` breaks `schema`, said so the model can fix it when it
 * is quoted back, or null when it fits.
 */
export function schemaViolation(schema: JsonSchema, value: unknown, path = 'the answer'): string | null {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
      const record = value as Record<string, unknown>;
      for (const key of schema.required) {
        if (!(key in record)) return `${path} is missing "${key}"`;
      }
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) return `${path} has "${key}", which is not in the schema`;
      }
      for (const [key, property] of Object.entries(schema.properties)) {
        if (!(key in record)) continue;
        const problem = schemaViolation(property, record[key], `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (const [index, item] of value.entries()) {
        const problem = schemaViolation(schema.items, item, `${path}[${index}]`);
        if (problem) return problem;
      }
      return null;
    }
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path} must be one of ${schema.enum.map((entry) => `"${entry}"`).join(', ')}`;
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} must match ${schema.pattern}`;
      return null;
    case 'integer':
      return Number.isInteger(value) ? null : `${path} must be a whole number`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${path} must be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be true or false`;
  }
}
