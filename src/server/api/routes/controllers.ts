import { Router } from 'express';
import { listControllers, addController, removeController } from '../../db/repositories/controllersRepo';
import { displayNames } from '../names';
import type { Controller, ControllerRow } from '@shared/types';

export const controllersRouter = Router();

const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * The panel used to match the stored id against a separately fetched roster of
 * its own, which is a second way of naming somebody and so a second way of
 * being wrong. Names come from here now, like everywhere else.
 */
function named(rows: ControllerRow[]): Controller[] {
  const names = displayNames(rows.map((row) => row.userId));
  return rows.map((row) => ({ ...row, name: names[row.userId] ?? row.userId }));
}

controllersRouter.get('/', (_req, res) => {
  res.json({ success: true, data: named(listControllers()) });
});

/**
 * A user id, and nothing else. The panel picks a person by name and sends their
 * id; what they are called is Discord's to say and is looked up when shown.
 */
controllersRouter.post('/', (req, res) => {
  const userId = typeof (req.body as { userId?: unknown })?.userId === 'string'
    ? ((req.body as { userId: string }).userId).trim()
    : '';
  if (!SNOWFLAKE_RE.test(userId)) {
    res.status(400).json({ success: false, error: 'userId must be a Discord snowflake (17-20 digits)' });
    return;
  }
  res.json({ success: true, data: named([addController(userId)])[0] });
});

controllersRouter.delete('/:userId', (req, res) => {
  const removed = removeController(req.params.userId);
  if (!removed) {
    res.status(404).json({ success: false, error: 'Controller not found' });
    return;
  }
  res.json({ success: true, data: { userId: req.params.userId } });
});
