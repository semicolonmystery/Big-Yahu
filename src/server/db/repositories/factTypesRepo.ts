import { asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { factTypes } from '../schema';
import { getSettings } from './settingsRepo';
import { DEFAULT_SETTINGS } from '@shared/constants';
import {
  BUILT_IN_FACT_TYPES,
  FACT_TYPES_MAX,
  FACT_TYPE_DESCRIPTION_MAX,
  FACT_TYPE_ID,
  FACT_TYPE_LABEL_MAX,
  type FactType,
} from '@shared/factTypes';

export class FactTypeError extends Error {}

/**
 * The global fact settings, which a new type copies and an untyped fact falls
 * back to. Read through the shipped defaults rather than straight off the row:
 * these columns are NOT NULL here, and a settings row written before one of them
 * existed would otherwise seed a type with nothing in it.
 */
const numberOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function globals(): Pick<FactType, 'duplicateDistance' | 'factSearchTopK' | 'factSearchMaxDistance'> {
  const settings = getSettings() as Partial<typeof DEFAULT_SETTINGS>;
  return {
    duplicateDistance: numberOr(settings.duplicateDistance, DEFAULT_SETTINGS.duplicateDistance),
    factSearchTopK: numberOr(settings.factSearchTopK, DEFAULT_SETTINGS.factSearchTopK),
    factSearchMaxDistance: numberOr(settings.factSearchMaxDistance, DEFAULT_SETTINGS.factSearchMaxDistance),
  };
}

/**
 * The shipped types are seeded on first read rather than by a migration, so the
 * descriptions stay in TypeScript where they are legible and diffable — they are
 * prose written at a model, not data. Each copies the global fact settings as it
 * is created, which is what makes the globals the seed rather than a parallel
 * set of numbers to keep in step.
 */
function seedIfEmpty(): void {
  if (db.select({ id: factTypes.id }).from(factTypes).limit(1).get()) return;
  const settings = globals();
  const now = Date.now();
  db.insert(factTypes).values(BUILT_IN_FACT_TYPES.map((type, position) => ({
    id: type.id,
    label: type.label,
    description: type.description,
    sortOrder: position,
    builtIn: true,
    duplicateDistance: type.overrides?.duplicateDistance ?? settings.duplicateDistance,
    factSearchTopK: type.overrides?.factSearchTopK ?? settings.factSearchTopK,
    factSearchMaxDistance: type.overrides?.factSearchMaxDistance ?? settings.factSearchMaxDistance,
    updatedAt: now,
  }))).onConflictDoNothing().run();
}

export function listFactTypes(): FactType[] {
  seedIfEmpty();
  return db.select().from(factTypes).orderBy(asc(factTypes.sortOrder), asc(factTypes.id)).all();
}

export function factTypeIds(): string[] {
  return listFactTypes().map((type) => type.id);
}

/** What the model is shown: the id it must answer with, and what belongs in it. */
export function factTypesForModel(): Array<{ id: string; description: string }> {
  return listFactTypes().map((type) => ({ id: type.id, description: type.description }));
}

export function getFactType(id: string): FactType | undefined {
  seedIfEmpty();
  return db.select().from(factTypes).where(eq(factTypes.id, id)).get();
}

/**
 * The settings a candidate is judged by.
 *
 * A fact carries several types, so the most conservative of them wins: the
 * tightest duplicate distance, and no dedupe at all if any of its types switches
 * the check off. `message` is on nearly everything and ships with it off, so
 * this is what usually decides — which is the intent, since two people saying
 * much the same thing on different days must not overwrite one another.
 *
 * A fact with no types falls back to the global settings.
 */
export function duplicateDistanceFor(types: string[] | undefined): number {
  const global = globals().duplicateDistance;
  if (!types || types.length === 0) return global;
  const known = types.map((id) => getFactType(id)?.duplicateDistance).filter((value) => value !== undefined);
  return known.length > 0 ? Math.min(...known) : global;
}

/** How many results a search naming this type may have, and how far they may be. */
export function searchLimitsFor(type: string | undefined): { topK: number; maxDistance: number } {
  const settings = globals();
  const row = type ? getFactType(type) : undefined;
  return {
    topK: row?.factSearchTopK ?? settings.factSearchTopK,
    maxDistance: (row?.factSearchMaxDistance ?? settings.factSearchMaxDistance) / 100,
  };
}

interface FactTypeInput {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  duplicateDistance?: unknown;
  factSearchTopK?: unknown;
  factSearchMaxDistance?: unknown;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function readNumber(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new FactTypeError(`${field} must be a number`);
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function readShape(input: FactTypeInput, existing?: FactType): Omit<FactType, 'id' | 'sortOrder' | 'builtIn'> {
  const settings = globals();
  const label = text(input.label) || existing?.label || '';
  const description = text(input.description) || existing?.description || '';
  if (!label) throw new FactTypeError('A type needs a label');
  if (label.length > FACT_TYPE_LABEL_MAX) throw new FactTypeError(`A label is at most ${FACT_TYPE_LABEL_MAX} characters`);
  if (!description) throw new FactTypeError('A type needs a description — it is what the model reads to use it');
  if (description.length > FACT_TYPE_DESCRIPTION_MAX) {
    throw new FactTypeError(`A description is at most ${FACT_TYPE_DESCRIPTION_MAX} characters`);
  }
  return {
    label,
    description,
    duplicateDistance: readNumber(input.duplicateDistance, 'duplicateDistance', 0, 100,
      existing?.duplicateDistance ?? settings.duplicateDistance),
    factSearchTopK: readNumber(input.factSearchTopK, 'factSearchTopK', 1, 50,
      existing?.factSearchTopK ?? settings.factSearchTopK),
    factSearchMaxDistance: readNumber(input.factSearchMaxDistance, 'factSearchMaxDistance', 0, 200,
      existing?.factSearchMaxDistance ?? settings.factSearchMaxDistance),
  };
}

export function addFactType(input: FactTypeInput): FactType {
  seedIfEmpty();
  const id = text(input.id).toLowerCase();
  if (!FACT_TYPE_ID.test(id)) {
    throw new FactTypeError('An id is lowercase letters, digits, hyphens and underscores, starting with a letter');
  }
  const existing = listFactTypes();
  if (existing.some((type) => type.id === id)) throw new FactTypeError(`There is already a "${id}" type`);
  if (existing.length >= FACT_TYPES_MAX) throw new FactTypeError(`${FACT_TYPES_MAX} types is the most the model can choose between`);

  const row = {
    id,
    ...readShape(input),
    sortOrder: existing.length,
    builtIn: false,
    updatedAt: Date.now(),
  };
  db.insert(factTypes).values(row).run();
  return row;
}

export function updateFactType(id: string, input: FactTypeInput): FactType {
  const existing = getFactType(id);
  if (!existing) throw new FactTypeError(`There is no "${id}" type`);
  const row = { ...existing, ...readShape(input, existing), updatedAt: Date.now() };
  db.update(factTypes).set(row).where(eq(factTypes.id, id)).run();
  return row;
}

/**
 * Removing a type does not touch the facts carrying it. Their metadata keeps the
 * id, which simply stops matching any search — recall reads the live list, so a
 * deleted type is one nothing can be aimed at rather than a rewrite of the store.
 * The cleanup pass is what re-sorts those facts, if the operator wants them moved.
 */
export function removeFactType(id: string): boolean {
  const existing = getFactType(id);
  if (!existing) return false;
  if (existing.builtIn) throw new FactTypeError(`"${id}" ships with the bot and cannot be removed`);
  db.delete(factTypes).where(eq(factTypes.id, id)).run();
  return true;
}

/** Puts the shipped types back as they came, leaving anything the operator added alone. */
export function resetBuiltInFactTypes(): FactType[] {
  seedIfEmpty();
  const settings = globals();
  const now = Date.now();
  for (const [position, type] of BUILT_IN_FACT_TYPES.entries()) {
    db.insert(factTypes).values({
      id: type.id,
      label: type.label,
      description: type.description,
      sortOrder: position,
      builtIn: true,
      duplicateDistance: type.overrides?.duplicateDistance ?? settings.duplicateDistance,
      factSearchTopK: type.overrides?.factSearchTopK ?? settings.factSearchTopK,
      factSearchMaxDistance: type.overrides?.factSearchMaxDistance ?? settings.factSearchMaxDistance,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: factTypes.id,
      set: {
        label: type.label,
        description: type.description,
        sortOrder: position,
        builtIn: true,
        duplicateDistance: type.overrides?.duplicateDistance ?? settings.duplicateDistance,
        factSearchTopK: type.overrides?.factSearchTopK ?? settings.factSearchTopK,
        factSearchMaxDistance: type.overrides?.factSearchMaxDistance ?? settings.factSearchMaxDistance,
        updatedAt: now,
      },
    }).run();
  }
  return listFactTypes();
}

/** Keeps only the ids that exist, so a model naming a type nobody defined cannot invent one. */
export function knownTypes(claimed: unknown): string[] {
  if (!Array.isArray(claimed)) return [];
  const known = new Set(factTypeIds());
  return [...new Set(claimed
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => known.has(value)))];
}
