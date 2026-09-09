import { Router } from 'express';
import type { CookieOptions, Request } from 'express';
import {
  createAdmin,
  elevateSession,
  createSession,
  destroySession,
  getAdmin,
  hasAdmin,
  isSessionValid,
  verifyPassword,
  AdminAlreadyExistsError,
} from '../../db/repositories/authRepo';
import { authRateLimit, clearAttempts } from '../middleware/authRateLimit';
import { SESSION_COOKIE, SESSION_TTL_MS } from '@shared/constants';

const MIN_PASSWORD_LENGTH = 8;

/**
 * `secure` follows the protocol actually in use, not NODE_ENV. A Secure cookie
 * sent over plain HTTP is silently dropped by the browser, which logs the admin
 * straight back out on any deployment not fronted by TLS. Behind a TLS proxy
 * `req.secure` picks up X-Forwarded-Proto (see the trust proxy setting).
 */
function cookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
  };
}

function readCredentials(body: unknown): { username: string; password: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { username, password } = body as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const trimmed = username.trim();
  if (!trimmed || !password) return null;
  return { username: trimmed, password };
}

export const authRouter = Router();

authRouter.get('/status', (req, res) => {
  const admin = getAdmin();
  const authenticated = isSessionValid(req.cookies?.[SESSION_COOKIE]);
  res.json({
    success: true,
    data: {
      hasAdmin: admin !== undefined,
      authenticated,
      username: authenticated ? (admin?.username ?? null) : null,
    },
  });
});

authRouter.post('/setup', authRateLimit, async (req, res) => {
  if (hasAdmin()) {
    res.status(409).json({ success: false, error: 'An admin account already exists' });
    return;
  }

  const credentials = readCredentials(req.body);
  if (!credentials) {
    res.status(400).json({ success: false, error: 'Username and password are required' });
    return;
  }
  if (credentials.password.length < MIN_PASSWORD_LENGTH) {
    res
      .status(400)
      .json({ success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }

  try {
    await createAdmin(credentials.username, credentials.password);
  } catch (error) {
    if (!(error instanceof AdminAlreadyExistsError)) throw error;
    res.status(409).json({ success: false, error: error.message });
    return;
  }
  clearAttempts(req);
  res.cookie(SESSION_COOKIE, createSession(), cookieOptions(req));
  res.json({ success: true, data: { username: credentials.username } });
});

authRouter.post('/login', authRateLimit, async (req, res) => {
  const credentials = readCredentials(req.body);
  // Malformed input still pays for a hash. Answering it instantly would say that
  // the body was the problem, which is one bit more than a stranger should get.
  const ok = credentials
    ? await verifyPassword(credentials.username, credentials.password)
    : await verifyPassword('', '');

  if (!credentials || !ok) {
    res.status(401).json({ success: false, error: 'Incorrect username or password' });
    return;
  }

  clearAttempts(req);
  res.cookie(SESSION_COOKIE, createSession(), cookieOptions(req));
  res.json({ success: true, data: { username: credentials.username } });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(req), maxAge: undefined });
  res.json({ success: true, data: null });
});

authRouter.post('/elevate', authRateLimit, async (req, res) => {
  const password = (req.body as { password?: unknown })?.password;
  const elevated =
    typeof password === 'string' && (await elevateSession(req.cookies?.[SESSION_COOKIE], password));

  if (!elevated) {
    res.status(401).json({ success: false, error: 'Incorrect password' });
    return;
  }

  clearAttempts(req);
  res.json({ success: true, data: null });
});
