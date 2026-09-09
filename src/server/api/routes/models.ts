import { Router } from 'express';
import {
  addModel,
  listModels,
  removeModel,
  reorderModels,
  reviveAll,
  setWeight,
} from '../../db/repositories/chatModelsRepo';

export const modelsRouter = Router();

const MODEL_PATTERN = /^[\w.:@/-]{1,100}$/;

function readWeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return Math.min(1000, Math.max(0, value));
}

modelsRouter.get('/', (_req, res) => {
  res.json({ success: true, data: listModels() });
});

modelsRouter.post('/', (req, res) => {
  const body = req.body as { model?: unknown; weight?: unknown };
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  if (!MODEL_PATTERN.test(model)) {
    res.status(400).json({ success: false, error: 'A model id is required' });
    return;
  }

  const weight = body.weight === undefined ? 100 : readWeight(body.weight);
  if (weight === null) {
    res.status(400).json({ success: false, error: 'weight must be a whole number' });
    return;
  }

  res.json({ success: true, data: addModel(model, weight) });
});

modelsRouter.patch('/:model', (req, res) => {
  const weight = readWeight((req.body as { weight?: unknown })?.weight);
  if (weight === null) {
    res.status(400).json({ success: false, error: 'weight must be a whole number' });
    return;
  }
  if (!setWeight(String(req.params.model), weight)) {
    res.status(404).json({ success: false, error: `"${String(req.params.model)}" is not in the pool` });
    return;
  }
  res.json({ success: true, data: listModels() });
});

/** Takes the whole list in display order, best first. */
modelsRouter.put('/order', (req, res) => {
  const order = (req.body as { order?: unknown })?.order;
  if (!Array.isArray(order) || order.some((entry) => typeof entry !== 'string')) {
    res.status(400).json({ success: false, error: 'order must be an array of model ids, best first' });
    return;
  }
  res.json({ success: true, data: reorderModels(order as string[]) });
});

/** Clears every rest period, for when a provider recovers sooner than expected. */
modelsRouter.post('/revive', (_req, res) => {
  reviveAll();
  res.json({ success: true, data: listModels() });
});

modelsRouter.delete('/:model', (req, res) => {
  if (!removeModel(String(req.params.model))) {
    res.status(404).json({ success: false, error: `"${String(req.params.model)}" is not in the pool` });
    return;
  }
  res.json({ success: true, data: listModels() });
});
