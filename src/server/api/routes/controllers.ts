import { Router } from 'express';
import { listControllers, addController, removeController } from '../../db/repositories/controllersRepo';

export const controllersRouter = Router();

const SNOWFLAKE_RE = /^\d{17,20}$/;

function readPayload(body: unknown): { userId: string; label: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { userId, label } = body as { userId?: unknown; label?: unknown };
  if (typeof userId !== 'string' || typeof label !== 'string') return null;
  const trimmedUserId = userId.trim();
  const trimmedLabel = label.trim();
  if (!trimmedUserId || !trimmedLabel) return null;
  return { userId: trimmedUserId, label: trimmedLabel };
}

controllersRouter.get('/', (_req, res) => {
  res.json({ success: true, data: listControllers() });
});

controllersRouter.post('/', (req, res) => {
  const payload = readPayload(req.body);
  if (!payload) {
    res.status(400).json({ success: false, error: 'userId and label are required' });
    return;
  }

  if (!SNOWFLAKE_RE.test(payload.userId)) {
    res.status(400).json({ success: false, error: 'userId must be a Discord snowflake (17-20 digits)' });
    return;
  }

  if (payload.label.length > 100) {
    res.status(400).json({ success: false, error: 'label must be at most 100 characters' });
    return;
  }

  res.json({ success: true, data: addController(payload.userId, payload.label) });
});

controllersRouter.delete('/:userId', (req, res) => {
  const removed = removeController(req.params.userId);
  if (!removed) {
    res.status(404).json({ success: false, error: 'Controller not found' });
    return;
  }
  res.json({ success: true, data: { userId: req.params.userId } });
});
