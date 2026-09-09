import { Router } from 'express';
import { getSettings, updateSettings, SettingsValidationError } from '../../db/repositories/settingsRepo';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings } from '@shared/types';

export const settingsRouter = Router();

// Derived so a new setting is accepted as soon as it has a default, rather than
// being silently dropped until someone remembers to update a second list.
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

function readPatch(body: unknown): Partial<AppSettings> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const patch: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (key in body) patch[key] = (body as Record<string, unknown>)[key];
  }
  return patch as Partial<AppSettings>;
}

settingsRouter.get('/', (_req, res) => {
  res.json({ success: true, data: getSettings() });
});

settingsRouter.patch('/', (req, res) => {
  const patch = readPatch(req.body);
  if (!patch) {
    res.status(400).json({ success: false, error: 'Request body must be an object' });
    return;
  }
  try {
    res.json({ success: true, data: updateSettings(patch) });
  } catch (error) {
    if (!(error instanceof SettingsValidationError)) throw error;
    res.status(400).json({ success: false, error: error.message });
  }
});
