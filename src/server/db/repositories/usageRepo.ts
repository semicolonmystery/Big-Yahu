import { desc, gte, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { db } from '../client';
import { aiUsage } from '../schema';
import type { AiUsageGroup, AiUsageSummary, AiUsageTotals } from '@shared/types';

export type UsageRow = typeof aiUsage.$inferInsert;

export function recordUsage(row: UsageRow): void {
  db.insert(aiUsage).values(row).run();
}

const DAY_MS = 24 * 60 * 60 * 1000;

const totals = {
  calls: sql<number>`count(*)`,
  failures: sql<number>`coalesce(sum(case when ${aiUsage.outcome} = 'ok' then 0 else 1 end), 0)`,
  cost: sql<number>`coalesce(sum(${aiUsage.cost}), 0)`,
  promptTokens: sql<number>`coalesce(sum(${aiUsage.promptTokens}), 0)`,
  cachedTokens: sql<number>`coalesce(sum(${aiUsage.cachedTokens}), 0)`,
  completionTokens: sql<number>`coalesce(sum(${aiUsage.completionTokens}), 0)`,
};

const EMPTY: AiUsageTotals = { calls: 0, failures: 0, cost: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 };

function totalsSince(since: number): AiUsageTotals {
  return db.select(totals).from(aiUsage).where(gte(aiUsage.at, since)).get() ?? EMPTY;
}

/** Most expensive first, so the thing worth looking at is at the top. */
function groupedSince(since: number, column: SQLiteColumn): AiUsageGroup[] {
  return db
    .select({ key: sql<string | null>`${column}`, ...totals })
    .from(aiUsage)
    .where(gte(aiUsage.at, since))
    .groupBy(column)
    .orderBy(desc(sql`sum(${aiUsage.cost})`))
    .all()
    .map((row) => ({ ...row, key: row.key ?? 'unknown' }));
}

/**
 * Rolling windows rather than calendar days: "the last 24 hours" means the same
 * thing whatever timezone the server or the operator is in.
 */
export function usageSummary(now: number = Date.now()): AiUsageSummary {
  const week = now - 7 * DAY_MS;
  return {
    day: totalsSince(now - DAY_MS),
    week: totalsSince(week),
    byTask: groupedSince(week, aiUsage.task),
    byModel: groupedSince(week, aiUsage.model),
    byProvider: groupedSince(week, aiUsage.provider),
  };
}
