import { eq } from 'drizzle-orm';
import { db } from '../client';
import { controllers } from '../schema';
import type { ControllerRow } from '@shared/types';

export function listControllers(): ControllerRow[] {
  return db.select().from(controllers).all();
}

export function isController(userId: string): boolean {
  return db.select().from(controllers).where(eq(controllers.userId, userId)).get() !== undefined;
}

export function addController(userId: string): ControllerRow {
  const row = { userId, addedAt: Date.now() };
  db.insert(controllers).values(row).onConflictDoNothing().run();
  return db.select().from(controllers).where(eq(controllers.userId, userId)).get() ?? row;
}

export function removeController(userId: string): boolean {
  const existing = db.select().from(controllers).where(eq(controllers.userId, userId)).get();
  if (!existing) return false;
  db.delete(controllers).where(eq(controllers.userId, userId)).run();
  return true;
}
