import type { NextFunction, Request, Response } from 'express';
import { isSessionElevated } from '../../db/repositories/authRepo';
import { SESSION_COOKIE } from '@shared/constants';

/** Plugin secrets need the password re-entered, not just a valid session. */
export function requireElevated(req: Request, res: Response, next: NextFunction): void {
  if (!isSessionElevated(req.cookies?.[SESSION_COOKIE])) {
    res.status(403).json({ success: false, error: 'Re-enter your password to view or change secrets' });
    return;
  }
  next();
}
