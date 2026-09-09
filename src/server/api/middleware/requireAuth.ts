import type { NextFunction, Request, Response } from 'express';
import { isSessionValid } from '../../db/repositories/authRepo';
import { SESSION_COOKIE } from '@shared/constants';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isSessionValid(req.cookies?.[SESSION_COOKIE])) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  next();
}
