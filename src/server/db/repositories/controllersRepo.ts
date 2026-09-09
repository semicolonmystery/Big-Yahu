import { eq } from 'drizzle-orm';
import { db } from '../client';
import { controllers } from '../schema';
import type { Controller } from '@shared/types';

export function listControllers(): Controller[] {
  return db.select().from(controllers).all();
}

export function isController(userId: string): boolean {
  return db.select().from(controllers).where(eq(controllers.userId, userId)).get() !== undefined;
}

export function addController(userId: string, label: string): Controller {
  const row = { userId, label, addedAt: Date.now() };
  db.insert(controllers).values(row).onConflictDoUpdate({ target: controllers.userId, set: { label } }).run();
  return row;
}

export function removeController(userId: string): boolean {
  const existing = db.select().from(controllers).where(eq(controllers.userId, userId)).get();
  if (!existing) return false;
  db.delete(controllers).where(eq(controllers.userId, userId)).run();
  return true;
}
