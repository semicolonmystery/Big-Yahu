import { Router } from 'express';
import {
  FactTypeError,
  addFactType,
  listFactTypes,
  removeFactType,
  resetBuiltInFactTypes,
  updateFactType,
} from '../../db/repositories/factTypesRepo';
import { untypedFactCount } from '../../db/repositories/factIndexRepo';
import { ensureFactIndex } from '../../db/repositories/factsRepo';

export const factTypesRouter = Router();

/**
 * Express 5 handles a rejected promise itself, so only the deliberate refusals
 * are caught here: a bad label or a duplicate id is the operator's mistake and
 * deserves the reason, not a 500.
 */
function refuse(res: Parameters<Parameters<Router['get']>[1]>[1], error: unknown): void {
  if (!(error instanceof FactTypeError)) throw error;
  res.status(400).json({ success: false, error: error.message });
}

factTypesRouter.get('/', async (_req, res) => {
  // How many facts nobody has sorted yet is the one number that says whether the
  // cleanup pass is still worth running.
  await ensureFactIndex();
  res.json({ success: true, data: { types: listFactTypes(), untypedFacts: untypedFactCount() } });
});

factTypesRouter.post('/', (req, res) => {
  try {
    res.json({ success: true, data: addFactType(req.body ?? {}) });
  } catch (error) {
    refuse(res, error);
  }
});

factTypesRouter.patch('/:id', (req, res) => {
  try {
    res.json({ success: true, data: updateFactType(req.params.id, req.body ?? {}) });
  } catch (error) {
    refuse(res, error);
  }
});

factTypesRouter.delete('/:id', (req, res) => {
  try {
    if (!removeFactType(req.params.id)) {
      res.status(404).json({ success: false, error: 'There is no type with that id' });
      return;
    }
    res.json({ success: true, data: { id: req.params.id } });
  } catch (error) {
    refuse(res, error);
  }
});

/** Puts the shipped types back as they came, leaving anything the operator added. */
factTypesRouter.post('/reset', (_req, res) => {
  res.json({ success: true, data: resetBuiltInFactTypes() });
});
