import type { PluginField, PluginSecretField } from '@big-yahu/plugin-sdk';

/**
 * Coercing what the admin panel sends against what a plugin says it wants.
 *
 * The panel used to be a JSON textarea, so every plugin had to defend itself
 * against a number arriving as a string or a key having been deleted. That
 * defence still belongs in the plugin — a config can be edited by other routes,
 * and `withDefaults` is cheap — but a declared schema means the panel can be
 * told what it is editing, and the save can refuse nonsense before it is stored
 * rather than after.
 */

const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function isUsableField(field: PluginField): boolean {
  if (!NAME_PATTERN.test(field.name) || !field.label?.trim()) return false;
  if (field.type === 'select') return Array.isArray(field.options) && field.options.length > 0;
  return true;
}

export function isUsableSecret(secret: PluginSecretField): boolean {
  return SECRET_NAME_PATTERN.test(secret.name) && Boolean(secret.label?.trim());
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceField(field: PluginField, value: unknown): unknown | undefined {
  switch (field.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      // A checkbox posted through a form-shaped client can arrive as a string.
      if (value === 'true' || value === 'false') return value === 'true';
      return undefined;

    case 'number': {
      const parsed = toNumber(value);
      if (parsed === null) return undefined;
      const floored = field.step !== undefined && Number.isInteger(field.step) ? Math.round(parsed) : parsed;
      const min = field.min ?? Number.NEGATIVE_INFINITY;
      const max = field.max ?? Number.POSITIVE_INFINITY;
      return Math.min(max, Math.max(min, floored));
    }

    case 'select': {
      const text = typeof value === 'string' ? value : String(value ?? '');
      return (field.options ?? []).some((option) => option.value === text) ? text : undefined;
    }

    case 'list': {
      if (!Array.isArray(value)) return undefined;
      if (field.itemType === 'number') {
        return value.map(toNumber).filter((entry): entry is number => entry !== null);
      }
      return value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry ?? '').trim()))
        .filter((entry) => entry.length > 0);
    }

    // Trimmed, because a model name or an id with a stray space pasted onto it
    // fails somewhere far away from the field that caused it. `text` is left
    // alone past the ends, since its whole point is that the shape matters.
    case 'string':
      return typeof value === 'string' ? value.trim() : value === null || value === undefined ? undefined : String(value).trim();

    case 'text':
    default:
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return undefined;
      return String(value);
  }
}

export interface CoercedConfig {
  config: Record<string, unknown>;
  /** Fields marked required that came back empty. Reported rather than silently saved. */
  missing: string[];
}

/**
 * Builds the config to store from what the panel sent, keeping the current value
 * for anything the panel left out.
 *
 * Keys already stored that the schema does not mention survive — a plugin may
 * hold state from before it declared a schema, and a save should not quietly
 * delete it. Keys the panel sends that the schema does not mention are ignored:
 * once a plugin says what its settings are, that list is the contract.
 *
 * Bounds here are the field's own; a plugin whose settings constrain each other
 * still has to sort that out when it reads them, which is what `withDefaults`
 * in the bundled plugins is for.
 */
export function coerceConfig(
  schema: PluginField[],
  incoming: Record<string, unknown>,
  current: Record<string, unknown>,
): CoercedConfig {
  const config: Record<string, unknown> = { ...current };
  const missing: string[] = [];

  for (const field of schema) {
    if (!isUsableField(field)) continue;

    const supplied = Object.prototype.hasOwnProperty.call(incoming, field.name);
    const coerced = supplied ? coerceField(field, incoming[field.name]) : undefined;
    if (coerced !== undefined) config[field.name] = coerced;

    if (field.required) {
      const value = config[field.name];
      const empty =
        value === undefined
        || value === null
        || (typeof value === 'string' && !value.trim())
        || (Array.isArray(value) && value.length === 0);
      if (empty) missing.push(field.label);
    }
  }

  return { config, missing };
}
