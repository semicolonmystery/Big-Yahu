import type { NextFunction, Request, Response } from 'express';

/**
 * Throttles the unauthenticated routes that verify a password.
 *
 * Two separate problems, so two separate limits.
 *
 * A single caller guessing passwords is stopped by the per-peer window: ten
 * attempts a quarter of an hour is far more than a person who knows their own
 * password ever needs, and far too few to guess anybody else's.
 *
 * A flood from many addresses is not, so there is also a ceiling on how many
 * password checks may be in flight at once. Each one is a deliberately expensive
 * scrypt on libuv's threadpool, which the rest of the process shares, so
 * unbounded concurrency is a way to make the bot stop answering without ever
 * guessing anything.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_IN_FLIGHT = 4;

/** Bounds the map. Old entries are swept first, so this is only ever hit under a real flood. */
const MAX_TRACKED_PEERS = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
let inFlight = 0;

/**
 * Who to count this attempt against.
 *
 * `req.ip` is safe to use here precisely because `trust proxy` is a hop count
 * rather than `true`: Express walks `X-Forwarded-For` from the right by exactly
 * the number of proxies the operator says are theirs, so anything a caller
 * prepended to the header is stepped over rather than believed. Set the count
 * wrong and this degrades to the nearest proxy's address, which throttles too
 * much rather than too little.
 *
 * With no proxy — the default, and what `docker compose up` gives you — `req.ip`
 * is the socket's own address and cannot be forged at all.
 */
function peerOf(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function sweep(now: number): void {
  for (const [peer, window] of windows) {
    if (window.resetAt <= now) windows.delete(peer);
  }
}

export function clearAttempts(req: Request): void {
  windows.delete(peerOf(req));
}

export function authRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();

  if (inFlight >= MAX_IN_FLIGHT) {
    res.status(429).json({ success: false, error: 'Too many sign-in attempts at once. Try again shortly.' });
    return;
  }

  const peer = peerOf(req);
  let window = windows.get(peer);
  if (!window || window.resetAt <= now) {
    window = { count: 0, resetAt: now + WINDOW_MS };
    if (windows.size >= MAX_TRACKED_PEERS) sweep(now);
    windows.set(peer, window);
  }

  if (window.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      success: false,
      error: `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
    return;
  }

  // Counted before the attempt rather than after it, so a request that never
  // finishes still costs the caller something.
  window.count += 1;
  inFlight += 1;
  res.on('finish', () => {
    inFlight -= 1;
  });
  res.on('close', () => {
    // 'finish' does not fire for a connection dropped mid-request, and a
    // counter that only ever goes up would wedge the route shut.
    if (!res.writableEnded) inFlight -= 1;
  });

  next();
}
