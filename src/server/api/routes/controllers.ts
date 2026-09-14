import { Router } from 'express';
import { listControllers, addController, removeController } from '../../db/repositories/controllersRepo';

export const controllersRouter = Router();

const SNOWFLAKE_RE = /^\d{17,20}$/;

controllersRouter.get('/', (_req, res) => {
  res.json({ success: true, data: listControllers() });
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
  res.json({ success: true, data: addController(userId) });
});

controllersRouter.delete('/:userId', (req, res) => {
  const removed = removeController(req.params.userId);
  if (!removed) {
    res.status(404).json({ success: false, error: 'Controller not found' });
    return;
  }
  res.json({ success: true, data: { userId: req.params.userId } });
});
