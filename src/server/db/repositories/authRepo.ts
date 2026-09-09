import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq, lt } from 'drizzle-orm';
import { db } from '../client';
import { adminUser, sessions } from '../schema';
import { SESSION_TTL_MS } from '@shared/constants';

const KEY_LENGTH = 64;
const ROW_ID = 1;

/**
 * Async, not scryptSync. The Express API and the Discord bot share one thread,
 * so every synchronous hash froze the bot as well as the panel for the tens of
 * milliseconds it took — and the login route is unauthenticated, so anyone could
 * ask for as many as they liked. The async form runs on libuv's threadpool
 * instead, which leaves the event loop free.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

async function hashPassword(password: string, salt: string): Promise<Buffer> {
  return scryptAsync(password, salt, KEY_LENGTH);
}

/**
 * A salt used only when there is nobody to check against, so a login attempt for
 * a username that does not exist costs exactly what a real one costs. Generated
 * per process and never stored — nothing is ever verified against it.
 */
const ABSENT_ADMIN_SALT = randomBytes(16).toString('hex');

/**
 * Compares two strings without leaking how far they matched, or how long they
 * are. `timingSafeEqual` refuses buffers of different lengths, and comparing
 * usernames directly would have leaked the length through that refusal, so both
 * sides are hashed to a fixed width first.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export function getAdmin() {
  return db.select().from(adminUser).where(eq(adminUser.id, ROW_ID)).get();
}

export function hasAdmin(): boolean {
  return getAdmin() !== undefined;
}

export async function createAdmin(username: string, password: string): Promise<void> {
  if (hasAdmin()) throw new Error('An admin account already exists');
  const salt = randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  db.insert(adminUser)
    .values({
      id: ROW_ID,
      username,
      passwordHash: hash.toString('hex'),
      passwordSalt: salt,
      createdAt: Date.now(),
    })
    .run();
}

/**
 * Every path through this costs the same: one scrypt, then two fixed-width
 * comparisons, with no early return anywhere.
 *
 * It used to return the moment the username did not match, which answered a
 * wrong username in microseconds and a right one in tens of milliseconds — a
 * clean oracle for whether an account name exists. A wrong username now hashes
 * against a throwaway salt so the work is identical, and both checks are
 * computed before either is consulted, so neither can short-circuit the other.
 */
export async function verifyPassword(username: string, password: string): Promise<boolean> {
  const admin = getAdmin();
  const salt = admin?.passwordSalt ?? ABSENT_ADMIN_SALT;
  const candidate = await hashPassword(password, salt);

  if (!admin) return false;

  const stored = Buffer.from(admin.passwordHash, 'hex');
  const passwordMatches = candidate.length === stored.length && timingSafeEqual(candidate, stored);
  const usernameMatches = constantTimeEquals(username, admin.username);
  return usernameMatches && passwordMatches;
}

export function createSession(): string {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.insert(sessions).values({ token, createdAt: now, expiresAt: now + SESSION_TTL_MS }).run();
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  return token;
}

export function isSessionValid(token: string | undefined): boolean {
  if (!token) return false;
  const session = db.select().from(sessions).where(eq(sessions.token, token)).get();
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    db.delete(sessions).where(eq(sessions.token, token)).run();
    return false;
  }
  return true;
}

export function destroySession(token: string | undefined): void {
  if (token) db.delete(sessions).where(eq(sessions.token, token)).run();
}

const ELEVATION_TTL_MS = 10 * 60 * 1000;

/** Re-entering the password unlocks plugin secrets for a short window. */
export async function elevateSession(token: string | undefined, password: string): Promise<boolean> {
  const admin = getAdmin();
  // Hashed even with no session and no admin, so a caller cannot tell the
  // difference between a wrong password and a missing prerequisite by timing.
  const matches = await verifyPassword(admin?.username ?? '', password);
  if (!token || !admin || !matches) return false;
  db.update(sessions).set({ elevatedUntil: Date.now() + ELEVATION_TTL_MS }).where(eq(sessions.token, token)).run();
  return true;
}

export function isSessionElevated(token: string | undefined): boolean {
  if (!token) return false;
  const session = db.select().from(sessions).where(eq(sessions.token, token)).get();
  return (session?.elevatedUntil ?? 0) > Date.now();
}
