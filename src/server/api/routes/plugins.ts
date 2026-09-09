import { Router } from 'express';
import multer from 'multer';
import {
  declaredSecretNames,
  listPluginSummaries,
  updatePluginState,
  loadPlugins,
  isBundled,
  listPages,
  listPanels,
  renderPage,
  renderPanel,
  runPageAction,
  runPanelAction,
} from '../../plugins/engine';
import { installFromGit, installFromZip, uninstall, uninstallAll } from '../../plugins/installer';
import { deleteAllEnv, deleteEnv, isValidEnvKey, listEnvKeys, readEnv, setEnv } from '../../db/repositories/pluginEnvRepo';
import { clearStorage } from '../../db/repositories/pluginStorageRepo';
import { deleteDatabase } from '../../plugins/database';
import { requireElevated } from '../middleware/requireElevated';

export const pluginsRouter = Router();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPatch(body: unknown): { enabled?: boolean; config?: Record<string, unknown> } | null {
  if (!isPlainObject(body)) return null;
  const { enabled, config } = body as { enabled?: unknown; config?: unknown };
  if (enabled !== undefined && typeof enabled !== 'boolean') return null;
  if (config !== undefined && !isPlainObject(config)) return null;
  const patch: { enabled?: boolean; config?: Record<string, unknown> } = {};
  if (enabled !== undefined) patch.enabled = enabled;
  if (config !== undefined) patch.config = config;
  return patch;
}

pluginsRouter.get('/', (_req, res) => {
  res.json({ success: true, data: listPluginSummaries() });
});

pluginsRouter.patch('/:id', (req, res) => {
  const patch = readPatch(req.body);
  if (!patch) {
    res.status(400).json({ success: false, error: 'Invalid plugin update payload' });
    return;
  }

  try {
    updatePluginState(req.params.id, patch);
  } catch (error) {
    res.status(404).json({ success: false, error: (error as Error).message });
    return;
  }

  const summary = listPluginSummaries().find((plugin) => plugin.id === req.params.id);
  res.json({ success: true, data: summary });
});

// Plugins are code, so an archive is held in memory and never written until it
// has been validated as a package.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

function summaryOf(id: string) {
  return listPluginSummaries().find((plugin) => plugin.id === id) ?? null;
}

pluginsRouter.post('/install', async (req, res) => {
  const body = req.body as { url?: unknown };
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!url) {
    res.status(400).json({ success: false, error: 'A git URL is required' });
    return;
  }

  try {
    const { manifest, updated } = await installFromGit(url);
    // The handles are closed and reopened by the reload; doing it after the
    // files are in place means an update never runs the old code against the
    // new migrations.
    await loadPlugins();
    res.json({ success: true, data: { plugin: summaryOf(manifest.id), updated } });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

pluginsRouter.post('/upload', upload.single('archive'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'A .zip file is required' });
    return;
  }

  try {
    const { manifest, updated } = await installFromZip(req.file.buffer);
    await loadPlugins();
    res.json({ success: true, data: { plugin: summaryOf(manifest.id), updated } });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

pluginsRouter.delete('/', async (_req, res) => {
  const removed = uninstallAll();
  for (const id of removed) {
    deleteAllEnv(id);
    clearStorage(id);
    deleteDatabase(id);
  }
  await loadPlugins();
  res.json({ success: true, data: { removed } });
});

pluginsRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (isBundled(id)) {
    res.status(400).json({ success: false, error: `"${id}" ships with the bot and cannot be uninstalled` });
    return;
  }
  deleteAllEnv(id);
  clearStorage(id);
  deleteDatabase(id);
  if (!uninstall(id)) {
    res.status(404).json({ success: false, error: `Plugin "${id}" is not installed` });
    return;
  }
  await loadPlugins();
  res.json({ success: true, data: { id } });
});

pluginsRouter.post('/reload', async (_req, res) => {
  await loadPlugins();
  res.json({ success: true, data: listPluginSummaries() });
});

// Names are harmless; values need the password re-entered.
pluginsRouter.get('/:id/env/keys', (req, res) => {
  res.json({ success: true, data: listEnvKeys(String(req.params.id)) });
});

pluginsRouter.get('/:id/env', requireElevated, (req, res) => {
  res.json({ success: true, data: readEnv(String(req.params.id)) });
});

pluginsRouter.put('/:id/env', requireElevated, (req, res) => {
  const values = (req.body as { values?: unknown })?.values;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    res.status(400).json({ success: false, error: 'values must be an object of name to value' });
    return;
  }

  const entries = Object.entries(values as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!isValidEnvKey(key)) {
      res.status(400).json({ success: false, error: `"${key}" is not a valid variable name — use A-Z, digits and underscores` });
      return;
    }
    if (typeof value !== 'string') {
      res.status(400).json({ success: false, error: `"${key}" must be a string` });
      return;
    }
  }

  const pluginId = String(req.params.id);
  setEnv(pluginId, Object.fromEntries(entries) as Record<string, string>);
  res.json({ success: true, data: listEnvKeys(pluginId) });
});

pluginsRouter.delete('/:id/env/:key', requireElevated, (req, res) => {
  const pluginId = String(req.params.id);
  const key = String(req.params.key);

  // A declared secret is one the plugin expects to exist. Emptying it is the
  // operator's business; removing the row is not, since the plugin would then be
  // asking for something the panel no longer offers a place to put.
  if (declaredSecretNames(pluginId).has(key)) {
    res.status(400).json({
      success: false,
      error: `"${key}" is one this plugin declares, so it cannot be removed. Clear its value instead.`,
    });
    return;
  }

  if (!deleteEnv(pluginId, key)) {
    res.status(404).json({ success: false, error: `"${key}" is not set` });
    return;
  }
  res.json({ success: true, data: { key } });
});

pluginsRouter.get('/:id/pages', (req, res) => {
  res.json({ success: true, data: listPages(String(req.params.id)) });
});

pluginsRouter.get('/:id/pages/:pageId', async (req, res) => {
  const number = (value: unknown): number | undefined => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const data = await renderPage(String(req.params.id), String(req.params.pageId), {
    page: number(req.query.page),
    pageSize: number(req.query.pageSize),
    query: typeof req.query.query === 'string' ? req.query.query : '',
  });
  res.json({ success: true, data });
});

pluginsRouter.post('/:id/pages/:pageId/actions/:actionId', async (req, res) => {
  // Absent for a button in the page header, which acts on the page rather than
  // on any one row.
  const supplied = (req.body as { rowId?: unknown })?.rowId;
  const rowId = typeof supplied === 'string' ? supplied : '';

  const result = await runPageAction(
    String(req.params.id),
    String(req.params.pageId),
    String(req.params.actionId),
    rowId,
  );
  res.json({ success: true, data: result });
});

pluginsRouter.get('/:id/panels', (req, res) => {
  res.json({ success: true, data: listPanels(String(req.params.id)) });
});

pluginsRouter.get('/:id/panels/:panelId', async (req, res) => {
  try {
    const view = await renderPanel(String(req.params.id), String(req.params.panelId));
    res.json({ success: true, data: view });
  } catch (error) {
    res.status(404).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

pluginsRouter.post('/:id/panels/:panelId/actions/:actionId', async (req, res) => {
  const raw = (req.body as { values?: unknown })?.values;
  const values: Record<string, string> = {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') values[key] = value;
    }
  }

  try {
    const result = await runPanelAction(
      String(req.params.id),
      String(req.params.panelId),
      String(req.params.actionId),
      values,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});
