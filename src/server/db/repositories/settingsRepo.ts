import { eq } from 'drizzle-orm';
import { db } from '../client';
import { settings } from '../schema';
import { DEFAULT_SETTINGS, DUPLICATE_DISTANCE_MAX, LANGUAGES, MAX_ESCALATION_DEPTH_HARD_CAP } from '@shared/constants';
import type { AppSettings } from '@shared/types';

const ROW_ID = 1;

export class SettingsValidationError extends Error {}

export function getSettings(): AppSettings {
  const row = db.select().from(settings).where(eq(settings.id, ROW_ID)).get();
  if (!row) {
    db.insert(settings).values({ id: ROW_ID, ...DEFAULT_SETTINGS, updatedAt: Date.now() }).run();
    return { ...DEFAULT_SETTINGS };
  }
  const { id: _id, updatedAt: _updatedAt, ...values } = row;
  return values;
}

type NumericSetting = {
  [K in keyof AppSettings]: AppSettings[K] extends number ? K : never;
}[keyof AppSettings];

type BooleanSetting = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];

type TextSetting = Exclude<keyof AppSettings, NumericSetting | BooleanSetting>;

const BOUNDS: Record<NumericSetting, { min: number; max: number }> = {
  checkIntervalMinutes: { min: 1, max: 24 * 60 },
  replyContextMessages: { min: 1, max: 100 },
  factSearchTopK: { min: 1, max: 50 },
  escalationLookbackHours: { min: 1, max: 24 * 30 },
  maxEscalationDepth: { min: 0, max: MAX_ESCALATION_DEPTH_HARD_CAP },
  rateLimitPerHour: { min: 0, max: 1000 },
  retryAttempts: { min: 0, max: 5 },
  retryDelayMs: { min: 0, max: 60_000 },
  duplicateDistance: { min: 1, max: DUPLICATE_DISTANCE_MAX },
  modelFailureThreshold: { min: 1, max: 20 },
  modelRestMinutes: { min: 1, max: 24 * 60 },
  maxImages: { min: 0, max: 16 },
  textAttachmentMaxKb: { min: 0, max: 64 },
  // 0 is meaningful: it switches cross-channel reading off entirely.
  crossChannelMessages: { min: 0, max: 100 },
};

const BOOLEAN_SETTINGS: BooleanSetting[] = ['visionEnabled'];

const TEXT_LIMITS: Record<TextSetting, number> = {
  chatModel: 100,
  timezone: 64,
  replyLanguage: 10,
  rateLimitMessage: 500,
  overloadMessage: 500,
  busyMessage: 500,
  errorMessage: 500,
  noCreditsMessage: 500,
};

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings() };

  for (const [key, bounds] of Object.entries(BOUNDS) as [NumericSetting, { min: number; max: number }][]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value)) throw new SettingsValidationError(`${key} must be an integer`);
    next[key] = Math.min(bounds.max, Math.max(bounds.min, value));
  }

  for (const key of BOOLEAN_SETTINGS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new SettingsValidationError(`${key} must be true or false`);
    next[key] = value;
  }

  for (const [key, maxLength] of Object.entries(TEXT_LIMITS) as [TextSetting, number][]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new SettingsValidationError(`${key} must be a string`);
    const trimmed = value.trim();
    if (!trimmed) throw new SettingsValidationError(`${key} cannot be empty`);
    next[key] = trimmed.slice(0, maxLength);
  }

  if (patch.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: next.timezone });
    } catch {
      throw new SettingsValidationError(`Unknown timezone: ${patch.timezone}`);
    }
  }

  if (patch.replyLanguage !== undefined && !LANGUAGES.some((language) => language.code === next.replyLanguage)) {
    throw new SettingsValidationError(`Unsupported language: ${patch.replyLanguage}`);
  }

  db.update(settings).set({ ...next, updatedAt: Date.now() }).where(eq(settings.id, ROW_ID)).run();
  return next;
}
