import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capabilitiesOf,
  catalogEndpoints,
  catalogModel,
  catalogModels,
  cheapestEndpoint,
  isPeak,
  priceAt,
  resetCatalogCache,
  type Pricing,
} from '../../src/server/ai/catalog';

// Trimmed from OpenRouter's public catalog as it stood on 11.9.2026.
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const base = { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000003' };
const peak = { prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.000000006' };
const deepseekPricing = {
  ...base,
  overrides: [
    { utc_days: ['saturday', 'sunday'], ...base },
    { utc_days: WEEKDAYS, utc_start: 0, utc_end: 100, ...base },
    { utc_days: WEEKDAYS, utc_start: 100, utc_end: 400, ...peak },
    { utc_days: WEEKDAYS, utc_start: 400, utc_end: 600, ...base },
    { utc_days: WEEKDAYS, utc_start: 600, utc_end: 1000, ...peak },
    { utc_days: WEEKDAYS, utc_start: 1000, utc_end: 0, ...base },
  ],
};

const MODELS = {
  data: [
    {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek: DeepSeek V4.1 Flash',
      context_length: 1048576,
      architecture: { input_modalities: ['text', 'image'] },
      pricing: deepseekPricing,
      supported_parameters: ['tools', 'tool_choice', 'response_format', 'structured_outputs', 'reasoning'],
    },
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek: DeepSeek V4 Pro',
      architecture: { input_modalities: ['text'] },
      pricing: { prompt: '0.000000954738', completion: '0.000001909476' },
      supported_parameters: ['tools', 'tool_choice', 'response_format'],
    },
  ],
};

const EMBEDDINGS = {
  data: [{
    id: 'openai/text-embedding-3-large',
    name: 'OpenAI: Text Embedding 3 Large',
    architecture: { input_modalities: ['text'] },
    pricing: { prompt: '0.00000013', completion: '0' },
  }],
};

const ENDPOINTS = {
  data: {
    endpoints: [
      {
        tag: 'deepseek', provider_name: 'DeepSeek', status: 0, pricing: deepseekPricing,
        supported_parameters: ['reasoning', 'tools', 'tool_choice', 'response_format', 'reasoning_effort'],
      },
      {
        tag: 'deepinfra/fp8', provider_name: 'DeepInfra', status: -2,
        pricing: { prompt: '0.0000002', completion: '0.0000006', input_cache_read: '0.000000006' },
        supported_parameters: ['tools', 'tool_choice', 'response_format', 'structured_outputs'],
      },
      {
        tag: 'gmicloud/fp8', provider_name: 'GMICloud', status: 0,
        pricing: { prompt: '0.0000003', completion: '0.0000012' },
        supported_parameters: ['reasoning', 'tools', 'tool_choice'],
      },
    ],
  },
};

let fetchMock: ReturnType<typeof vi.fn>;
let offline = false;

beforeEach(() => {
  resetCatalogCache();
  offline = false;
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (offline) throw new TypeError('fetch failed');
    const url = String(input);
    if (url.endsWith('/embeddings/models')) return Response.json(EMBEDDINGS);
    if (url.endsWith('/models')) return Response.json(MODELS);
    if (url.endsWith('/models/deepseek/deepseek-v4.1-flash/endpoints')) return Response.json(ENDPOINTS);
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the catalog', () => {
  it('takes chat and embedding models, with what they accept and cost', async () => {
    const flash = await catalogModel('deepseek/deepseek-v4.1-flash');
    expect(flash).toMatchObject({ kind: 'chat', inputModalities: ['text', 'image'], contextLength: 1048576 });
    expect(flash?.pricing.prompt).toBeCloseTo(0.15e-6);
    expect(flash?.pricing.overrides).toHaveLength(6);
    expect((await catalogModel('openai/text-embedding-3-large'))?.kind).toBe('embedding');
    expect(await catalogModel('nobody/nothing')).toBeNull();
  });

  it('judges a pinned row by its own host, not by what some other host supports', async () => {
    expect(await capabilitiesOf('deepseek/deepseek-v4.1-flash', 'deepseek'))
      .toEqual({ images: true, tools: true, jsonMode: true });
    // Matched by the provider in front of the slash, as a pin may be written.
    expect(await capabilitiesOf('deepseek/deepseek-v4.1-flash', 'gmicloud'))
      .toEqual({ images: true, tools: true, jsonMode: false });
    expect(await capabilitiesOf('deepseek/deepseek-v4-pro', ''))
      .toEqual({ images: false, tools: true, jsonMode: true });
    expect(await capabilitiesOf('nobody/nothing', 'deepseek')).toBeNull();
  });

  it('pins new rows to the cheapest healthy host that can do the job', async () => {
    expect(await cheapestEndpoint('deepseek/deepseek-v4.1-flash', { tools: true, jsonMode: true })).toBe('deepseek');
    expect(await cheapestEndpoint('nobody/nothing', { tools: false, jsonMode: false })).toBe('');
  });

  it('refuses a malformed model id without asking OpenRouter anything', async () => {
    expect(await catalogEndpoints('../../etc/passwd')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('caching', () => {
  it('asks once an hour, and keeps the last copy when a refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 11, 12));
    await catalogModels();
    await catalogModels();
    expect(fetchMock).toHaveBeenCalledTimes(2); // /models and /embeddings/models, once

    vi.setSystemTime(Date.UTC(2026, 8, 11, 14));
    offline = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await catalogModels()).map((model) => model.id)).toContain('deepseek/deepseek-v4.1-flash');
  });

  it('fails when there has never been a catalog', async () => {
    offline = true;
    await expect(catalogModels()).rejects.toThrow('fetch failed');
  });
});

describe('time-of-day pricing', () => {
  const pricing = async (): Promise<Pricing> => (await catalogModel('deepseek/deepseek-v4.1-flash'))!.pricing;

  it.each([
    ['a weekday at 02:30 UTC', Date.UTC(2026, 8, 15, 2, 30), true],
    ['a weekday at 05:00 UTC', Date.UTC(2026, 8, 15, 5, 0), false],
    ['a weekday at 09:59 UTC', Date.UTC(2026, 8, 15, 9, 59), true],
    ['a weekday at 10:00 UTC', Date.UTC(2026, 8, 15, 10, 0), false],
    ['a Saturday at 02:30 UTC', Date.UTC(2026, 8, 12, 2, 30), false],
  ])('knows DeepSeek is at peak on %s: %s', async (_label, at, expected) => {
    const prices = await pricing();
    expect(isPeak(prices, new Date(at))).toBe(expected);
    expect(priceAt(prices, new Date(at)).prompt).toBeCloseTo(expected ? 0.3e-6 : 0.15e-6);
  });

  it('applies an override with no days to every day', () => {
    const everyDay: Pricing = {
      prompt: 0.58e-6, completion: 1.7e-6, cacheRead: null,
      overrides: [{ days: null, start: 0, end: 1400, prompt: 1.1e-6, completion: 3.3e-6, cacheRead: null }],
    };
    expect(priceAt(everyDay, new Date(Date.UTC(2026, 8, 13, 13))).prompt).toBeCloseTo(1.1e-6);
    expect(priceAt(everyDay, new Date(Date.UTC(2026, 8, 13, 15))).prompt).toBeCloseTo(0.58e-6);
  });
});
