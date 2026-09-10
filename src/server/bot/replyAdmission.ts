import { reserveReplyAttempt } from '../db/repositories/replyAttemptsRepo';

const MAX_CONCURRENT_REPLIES = 4;
const users = new Set<string>();
let active = 0;

/** No unbounded queue: overload is rejected before attachments or model calls. */
export function admitReply(messageId: string, userId: string, hourlyLimit: number): (() => void) | null {
  if (active >= MAX_CONCURRENT_REPLIES || users.has(userId)) return null;
  if (!reserveReplyAttempt(messageId, userId, hourlyLimit)) return null;
  users.add(userId);
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users.delete(userId);
    active -= 1;
  };
}
