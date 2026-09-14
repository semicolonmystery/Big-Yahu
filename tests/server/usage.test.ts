import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/server/db/client';
import { aiUsage } from '../../src/server/db/schema';
import { recordCall } from '../../src/server/ai/usage';
import { recordUsage, usageSummary } from '../../src/server/db/repositories/usageRepo';

beforeEach(() => {
  db.delete(aiUsage).run();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// A reply-sized call as OpenRouter billed it during the 11.9.2026 probe.
const billed = {
  provider: 'DeepSeek',
  usage: {
    prompt_tokens: 5460,
    completion_tokens: 20,
    cost: 0.000435864,
    prompt_tokens_details: { cached_tokens: 2688 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
};

describe('recording a model call', () => {
  it('keeps what OpenRouter billed, the host that served it, and the cache share', () => {
    recordCall({ task: 'reply', model: 'deepseek/deepseek-v4.1-flash', startedAt: Date.now() - 1200, response: billed, outcome: 'ok' });

    const [row] = db.select().from(aiUsage).all();
    expect(row).toMatchObject({
      task: 'reply',
      model: 'deepseek/deepseek-v4.1-flash',
      provider: 'DeepSeek',
      promptTokens: 5460,
      cachedTokens: 2688,
      completionTokens: 20,
      reasoningTokens: 0,
      cost: 0.000435864,
      outcome: 'ok',
    });
    expect(row.latencyMs).toBeGreaterThanOrEqual(1200);
  });

  it('records a failure with nothing billed rather than skipping it', () => {
    recordCall({ task: 'topicExtraction', model: 'deepseek/deepseek-v4.1-flash', startedAt: Date.now(), outcome: 'error' });

    const [row] = db.select().from(aiUsage).all();
    expect(row).toMatchObject({ provider: null, promptTokens: 0, cost: 0, outcome: 'error' });
  });

  it('stores garbage in the usage block as zero instead of NaN', () => {
    recordCall({
      task: 'reply', model: 'm', startedAt: Date.now(), outcome: 'ok',
      response: { usage: { prompt_tokens: 'lots', cost: Number.NaN, completion_tokens: -3 } },
    });

    const [row] = db.select().from(aiUsage).all();
    expect(row).toMatchObject({ promptTokens: 0, cost: 0, completionTokens: 0 });
  });
});

describe('summarising usage', () => {
  const now = Date.UTC(2026, 8, 11, 12);
  const row = (hoursAgo: number, overrides: Partial<typeof aiUsage.$inferInsert> = {}) => recordUsage({
    at: now - hoursAgo * 60 * 60 * 1000,
    task: 'reply',
    model: 'deepseek/deepseek-v4.1-flash',
    provider: 'DeepSeek',
    promptTokens: 1000,
    cachedTokens: 800,
    completionTokens: 50,
    reasoningTokens: 0,
    cost: 0.001,
    latencyMs: 900,
    outcome: 'ok',
    ...overrides,
  });

  it('splits the last day from the last week and leaves older calls out', () => {
    row(1);
    row(30, { outcome: 'error', cost: 0 });
    row(24 * 8);

    const summary = usageSummary(now);
    expect(summary.day).toMatchObject({ calls: 1, failures: 0, cost: 0.001 });
    expect(summary.week).toMatchObject({ calls: 2, failures: 1, promptTokens: 2000, cachedTokens: 1600 });
  });

  it('groups by task, model and host, most expensive first', () => {
    row(1, { task: 'reply', cost: 0.001 });
    row(2, { task: 'factExtraction', cost: 0.004, model: 'other/model' });
    row(3, { task: 'reply', cost: 0.002, provider: null });

    const summary = usageSummary(now);
    expect(summary.byTask.map((group) => [group.key, group.calls])).toEqual([['factExtraction', 1], ['reply', 2]]);
    expect(summary.byModel[0]).toMatchObject({ key: 'other/model', cost: 0.004 });
    expect(summary.byProvider.map((group) => group.key)).toContain('unknown');
  });

  it('is all zeros before anything has been recorded', () => {
    expect(usageSummary(now)).toEqual({
      day: { calls: 0, failures: 0, cost: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
      week: { calls: 0, failures: 0, cost: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
      byTask: [],
      byModel: [],
      byProvider: [],
    });
  });
});
