import { Router, type Response } from 'express';
import { env } from '../../env';
import {
  capabilitiesOf,
  catalogEndpoints,
  catalogModel,
  catalogModels,
  cheapestEndpoint,
  endpointFor,
} from '../../ai/catalog';
import { listPluginAiTasks } from '../../plugins/engine';
import {
  addTaskModel,
  listTaskModels,
  removeTaskModel,
  reorderTaskModels,
  reviveTask,
  setTaskModelUpstream,
} from '../../db/repositories/taskModelsRepo';
import { reasoningEffortFor, setReasoningEffort } from '../../db/repositories/aiTasksRepo';
import { setState } from '../../db/repositories/pluginStateRepo';
import { getSettings } from '../../db/repositories/settingsRepo';
import {
  BUILT_IN_AI_TASKS,
  REASONING_EFFORTS,
  SHARED_PLUGIN_TASK,
  builtInTask,
  pluginTaskId,
  type AiTaskDefinition,
  type ReasoningEffort,
} from '@shared/aiTasks';
import type { AiTaskView, AiTasksOverview, CatalogEndpoint, CatalogModel, TaskModelView } from '@shared/types';

export const aiTasksRouter = Router();

const MODEL_ID = /^~?[\w.:-]+\/[\w.:-]+$/;
const UPSTREAM = /^([\w.-]+(\/[\w.-]+)?)?$/;
const PER_MILLION = 1_000_000;

const perMillion = (price: number | null): number | null => (price === null ? null : price * PER_MILLION);

/** Problems with one list, in the words an operator needs, worst first. */
function warningsFor(task: AiTaskDefinition, models: TaskModelView[], visionEnabled: boolean): string[] {
  if (models.length === 0) return [`Nothing is on this list, so ${task.label.toLowerCase()} cannot run at all.`];

  const warnings: string[] = [];
  if (models.every((entry) => entry.retired)) {
    warnings.push('Every model here has been retired for not existing. Press Reset errors, or add one that does.');
  }
  for (const entry of models) {
    const where = entry.upstream ? ` on ${entry.upstream}` : '';
    const capabilities = entry.capabilities;
    if (!capabilities) {
      warnings.push(`${entry.model} is not in OpenRouter's catalog, so what it can do is unknown.`);
      continue;
    }
    if (task.usesTools && !capabilities.tools) {
      warnings.push(`${entry.model}${where} cannot call tools, and this task needs them.`);
    }
    if (task.structured && !capabilities.jsonMode) {
      warnings.push(`${entry.model}${where} cannot answer in JSON mode, and this task needs it.`);
    }
    if (task.usesImages && visionEnabled && !capabilities.images) {
      warnings.push(
        `${entry.model} cannot see pictures. Requests with pictures go to models that can first, and it only `
          + 'gets them if all of those fail, with the pictures marked as not shown.',
      );
    }
    if (!entry.upstream) {
      warnings.push(`${entry.model} is not pinned to a host, so OpenRouter may send it somewhere that charges more.`);
    }
  }
  return warnings;
}

/**
 * A plugin's own job, as a task. Structured like the built-in structured ones:
 * an answer a plugin's code reads, so JSON mode and no reasoning.
 */
function pluginTaskDefinitions(): AiTaskDefinition[] {
  return listPluginAiTasks()
    .filter((plugin) => !plugin.useSharedModels)
    .flatMap((plugin) => plugin.tasks.map((task) => ({
      id: pluginTaskId(plugin.pluginId, task.id),
      label: `${plugin.pluginName}: ${task.label}`,
      description: task.description ?? `A job ${plugin.pluginName} sends to a model.`,
      usesImages: task.needsImages ?? false,
      usesTools: false,
      structured: true,
    })));
}

function allTaskDefinitions(): AiTaskDefinition[] {
  return [...BUILT_IN_AI_TASKS, ...pluginTaskDefinitions()];
}

async function overview(): Promise<AiTasksOverview> {
  let catalogAvailable = true;
  try {
    await catalogModels();
  } catch (error) {
    console.warn('[ai] OpenRouter catalog unavailable:', error);
    catalogAvailable = false;
  }

  const { visionEnabled } = getSettings();
  const tasks: AiTaskView[] = await Promise.all(allTaskDefinitions().map(async (task) => {
    const models: TaskModelView[] = await Promise.all(listTaskModels(task.id).map(async (entry) => ({
      ...entry,
      capabilities: catalogAvailable ? await capabilitiesOf(entry.model, entry.upstream).catch(() => null) : null,
    })));
    return {
      ...task,
      reasoningEffort: reasoningEffortFor(task.id),
      models,
      warnings: catalogAvailable ? warningsFor(task, models, visionEnabled) : [],
    };
  }));
  return {
    tasks,
    plugins: listPluginAiTasks().map((plugin) => ({
      pluginId: plugin.pluginId,
      pluginName: plugin.pluginName,
      useSharedModels: plugin.useSharedModels,
      tasks: plugin.tasks.map((task) => ({ id: task.id, label: task.label, description: task.description })),
    })),
    openrouterConfigured: Boolean(env.openrouterApiKey),
    catalogAvailable,
  };
}

function taskFrom(id: unknown, res: Response): AiTaskDefinition | null {
  const task = typeof id === 'string'
    ? builtInTask(id) ?? pluginTaskDefinitions().find((entry) => entry.id === id)
    : undefined;
  if (!task) res.status(404).json({ success: false, error: `There is no AI task called "${String(id)}"` });
  return task ?? null;
}

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Why a model cannot go on this list on this host, or null when it can. A
 * catalog that cannot be reached is not a reason: the row is taken unchecked,
 * and the overview flags it once the catalog is back.
 */
async function refusal(task: AiTaskDefinition, model: string, upstream: string): Promise<string | null> {
  let info;
  try {
    info = await catalogModel(model);
  } catch {
    return null;
  }
  if (!info || info.kind !== 'chat') return `${model} is not a chat model OpenRouter knows.`;
  if (upstream) {
    const hosts = await catalogEndpoints(model).catch(() => null);
    if (hosts && !endpointFor(hosts, upstream)) return `${model} is not served by ${upstream}.`;
  }
  const capabilities = await capabilitiesOf(model, upstream).catch(() => null);
  const where = upstream ? ` on ${upstream}` : '';
  if (capabilities && task.usesTools && !capabilities.tools) {
    return `${model}${where} cannot call tools, and ${task.label} needs them.`;
  }
  if (capabilities && task.structured && !capabilities.jsonMode) {
    return `${model}${where} cannot answer in JSON mode, and ${task.label} needs it.`;
  }
  return null;
}

aiTasksRouter.get('/', async (_req, res) => {
  res.json({ success: true, data: await overview() });
});

/** Search for the add-a-model box. Chat models only, since every list here is for chat. */
aiTasksRouter.get('/catalog', async (req, res) => {
  const query = readString(req.query.q).toLowerCase();
  let list;
  try {
    list = await catalogModels();
  } catch {
    res.status(503).json({ success: false, error: "OpenRouter's model list could not be reached" });
    return;
  }
  const data: CatalogModel[] = list
    .filter((model) => model.kind === 'chat')
    .filter((model) => !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query))
    .slice(0, 40)
    .map((model) => ({
      id: model.id,
      name: model.name,
      images: model.inputModalities.includes('image'),
      promptPrice: perMillion(model.pricing.prompt),
      completionPrice: perMillion(model.pricing.completion),
    }));
  res.json({ success: true, data });
});

/** The hosts serving one model, cheapest first, for the pin picker. */
aiTasksRouter.get('/catalog/endpoints', async (req, res) => {
  const model = readString(req.query.model);
  if (!MODEL_ID.test(model)) {
    res.status(400).json({ success: false, error: 'Use an OpenRouter model id, like deepseek/deepseek-v4.1-flash' });
    return;
  }
  let hosts;
  try {
    hosts = await catalogEndpoints(model);
  } catch {
    res.status(503).json({ success: false, error: "OpenRouter's host list could not be reached" });
    return;
  }
  const data: CatalogEndpoint[] = hosts
    .map((host) => ({
      tag: host.tag,
      providerName: host.providerName,
      promptPrice: perMillion(host.pricing.prompt),
      completionPrice: perMillion(host.pricing.completion),
      cacheReadPrice: perMillion(host.pricing.cacheRead),
      timeOfDayPricing: host.pricing.overrides.length > 0,
      tools: host.supportedParameters.includes('tools') && host.supportedParameters.includes('tool_choice'),
      jsonMode: host.supportedParameters.includes('response_format'),
      healthy: host.status === null || host.status >= 0,
    }))
    .sort((a, b) => (a.promptPrice ?? Infinity) - (b.promptPrice ?? Infinity));
  res.json({ success: true, data });
});

/**
 * Switching a plugin off the shared list gives each of its jobs a list of its
 * own, seeded from the shared one — otherwise it would have nothing to run on
 * the moment the switch was flipped.
 */
aiTasksRouter.patch('/plugins/:pluginId', async (req, res) => {
  const pluginId = String(req.params.pluginId);
  const known = listPluginAiTasks().find((plugin) => plugin.pluginId === pluginId);
  if (!known) {
    res.status(404).json({ success: false, error: `No enabled plugin called "${pluginId}" sends work to a model` });
    return;
  }
  const useSharedModels = (req.body as { useSharedModels?: unknown })?.useSharedModels;
  if (typeof useSharedModels !== 'boolean') {
    res.status(400).json({ success: false, error: 'useSharedModels must be true or false' });
    return;
  }

  setState(pluginId, { useSharedModels });
  if (!useSharedModels) {
    for (const task of known.tasks) {
      const id = pluginTaskId(pluginId, task.id);
      if (listTaskModels(id).length > 0) continue;
      for (const entry of listTaskModels(SHARED_PLUGIN_TASK)) addTaskModel(id, entry.model, entry.upstream);
    }
  }
  res.json({ success: true, data: await overview() });
});

aiTasksRouter.patch('/:task', async (req, res) => {
  const task = taskFrom(req.params.task, res);
  if (!task) return;
  const effort = readString((req.body as { reasoningEffort?: unknown })?.reasoningEffort);
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    res.status(400).json({ success: false, error: `reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}` });
    return;
  }
  setReasoningEffort(task.id, effort as ReasoningEffort);
  res.json({ success: true, data: await overview() });
});

aiTasksRouter.post('/:task/models', async (req, res) => {
  const task = taskFrom(req.params.task, res);
  if (!task) return;
  const body = (req.body ?? {}) as { model?: unknown; upstream?: unknown };
  const model = readString(body.model);
  if (!MODEL_ID.test(model)) {
    res.status(400).json({ success: false, error: 'Use an OpenRouter model id, like deepseek/deepseek-v4.1-flash' });
    return;
  }
  let upstream = body.upstream === undefined ? null : readString(body.upstream);
  if (upstream !== null && !UPSTREAM.test(upstream)) {
    res.status(400).json({ success: false, error: 'upstream must be an OpenRouter host, like deepseek' });
    return;
  }

  // Unless told otherwise, pin to the cheapest host that can do the job.
  upstream ??= await cheapestEndpoint(model, { tools: task.usesTools, jsonMode: task.structured }).catch(() => '');
  const reason = await refusal(task, model, upstream);
  if (reason) {
    res.status(400).json({ success: false, error: reason });
    return;
  }
  addTaskModel(task.id, model, upstream);
  res.json({ success: true, data: await overview() });
});

aiTasksRouter.patch('/:task/models', async (req, res) => {
  const task = taskFrom(req.params.task, res);
  if (!task) return;
  const body = (req.body ?? {}) as { model?: unknown; upstream?: unknown };
  const model = readString(body.model);
  const upstream = readString(body.upstream);
  if (!UPSTREAM.test(upstream)) {
    res.status(400).json({ success: false, error: 'upstream must be an OpenRouter host, like deepseek, or empty' });
    return;
  }
  const reason = await refusal(task, model, upstream);
  if (reason) {
    res.status(400).json({ success: false, error: reason });
    return;
  }
  if (!setTaskModelUpstream(task.id, model, upstream)) {
    res.status(404).json({ success: false, error: `${model} is not on the ${task.label} list` });
    return;
  }
  res.json({ success: true, data: await overview() });
});

/** Takes the whole list in display order, best first. */
aiTasksRouter.put('/:task/models/order', async (req, res) => {
  const task = taskFrom(req.params.task, res);
  if (!task) return;
  const order = (req.body as { order?: unknown })?.order;
  if (!Array.isArray(order) || order.some((entry) => typeof entry !== 'string')) {
    res.status(400).json({ success: false, error: 'order must be an array of model ids, best first' });
    return;
  }
  reorderTaskModels(task.id, order as string[]);
  res.json({ success: true, data: await overview() });
});

/** The model travels in the query: OpenRouter ids contain a slash, which a path segment cannot carry. */
aiTasksRouter.delete('/:task/models', async (req, res) => {
  const task = taskFrom(req.params.task, res);
  if (!task) return;
  const model = readString(req.query.model);
  if (!removeTaskModel(task.id, model)) {
    res.status(404).json({ success: false, error: `${model || 'That model'} is not on the ${task.label} list` });
    return;
  }
  res.json({ success: true, data: await overview() });
});

aiTasksRouter.post('/:task/revive', async (req, res) => {
  const task = taskFrom(req.params.task, res);
  if (!task) return;
  reviveTask(task.id);
  res.json({ success: true, data: await overview() });
});
