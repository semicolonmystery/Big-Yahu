/**
 * Whether bundling actually earns its tokens, asked of a real model.
 *
 * Sends the same channel twice as a reply would — once as one document holding
 * the whole window, once as sealed bundles ahead of a volatile tail — and reads
 * the cached-token count back off the usage. The second call of each pair is the
 * one that matters: that is the shape a busy channel is in.
 *
 *   npx tsx scripts/bundling-probe.ts [model] [messages] [anchored|sliding] [slide]
 *
 * What it found, and why the shape of this matters: caching is prefix-based, so
 * it pays only when a request *begins* with what an earlier one began with.
 * Production stamps `now` into the first field of the material, which breaks
 * that on its own — which is why a single document never caches, whatever else
 * is true, and why bundles have to sit ahead of it.
 *
 * Measured on gemini-3.5-flash-lite, history of 120 messages, bundles of 5:
 *   sliding by 2   one document 0%    bundled 69%
 *   sliding by 5   one document 0%    bundled 0%   (a whole bundle fell off the front)
 *   anchored       one document 0%    bundled 87%
 * Below roughly 18k prompt tokens nothing cached at all, in any shape.
 *
 * It costs real money — a few cents a run — so nothing calls it on its own and
 * it is not part of `npm run check`.
 */
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { REPLY_DEFAULT } from '../src/server/ai/prompts/systemInstructions';

dotenv.config();

const MODEL = process.argv[2] ?? 'google/gemini-3.5-flash-lite';
const BUNDLE = 5;
const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0 });

/** Long enough that a provider bothers caching it at all. */
const line = (n: number) =>
  `tohle je zprava cislo ${n} v kanalu, nese dost textu na to aby se prefix vubec vyplatilo cachovat, `
  + `a pokracuje jeste kousek aby to nebylo prilis kratke, konec zpravy ${n}.`;

let clock = 0;
const now = () => `23.9.2026 10:${String(clock++).padStart(2, '0')}`;

const message = (n: number) => ({ id: String(n), at: '2026-09-23T10:00:00.000Z', authorId: '111', content: line(n) });

async function send(parts: string[]): Promise<{ prompt: number; cached: number; cost: number }> {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: REPLY_DEFAULT },
      ...parts.map((content) => ({ role: 'user' as const, content })),
    ],
    max_tokens: 24,
  } as never);
  const usage = response.usage as {
    prompt_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number };
  } | undefined;
  return { prompt: usage?.prompt_tokens ?? 0, cached: usage?.prompt_tokens_details?.cached_tokens ?? 0, cost: usage?.cost ?? 0 };
}

/**
 * The window slides — it is the last N messages, so as a channel talks the
 * oldest drop off the front. That is the thing that breaks caching, and a probe
 * that appends instead of sliding measures nothing: appending leaves the whole
 * prefix intact and everything looks cached.
 */
const window = (from: number, count: number) => Array.from({ length: count }, (_, i) => message(from + i));

/** One document holding the whole window, which is what the reply sent before. */
const asOneDocument = (from: number, count: number): string[] => [JSON.stringify({
  now: now(), channel: { id: 'c' }, messages: window(from, count),
})];

/**
 * Sealed bundles first, then the volatile tail. The bundles are cut on absolute
 * message numbers, so the same run of five is the same bytes however far the
 * window has slid — which is the entire point of storing the cuts.
 */
const asBundles = (from: number, count: number): string[] => {
  const parts: string[] = [];
  const end = from + count;
  // First bundle boundary at or after the start of the window.
  let at = Math.ceil((from - 1) / BUNDLE) * BUNDLE + 1;
  for (; at + BUNDLE <= end; at += BUNDLE) parts.push(JSON.stringify({ earlierMessages: window(at, BUNDLE) }));
  parts.push(JSON.stringify({ now: now(), channel: { id: 'c' }, messages: window(at, end - at) }));
  return parts;
};

const pause = () => new Promise((resolve) => { setTimeout(resolve, 2000); });

const main = async (): Promise<void> => {
  console.log(`model: ${MODEL}\n`);
  let spent = 0;

  const count = Number(process.argv[3] ?? 120);
  for (const [label, build] of [['one document', asOneDocument], ['bundled', asBundles]] as const) {
    // Two replies five messages apart in a channel that keeps talking: the
    // window is the same length both times and has slid forward.
    const anchored = process.argv[4] === 'anchored';
    // Anchored: the history keeps its oldest end and grows at the new one, so
    // what is at the front of the request does not move. Sliding: the window is
    // a fixed length and the oldest messages fall off, which is what a long
    // conversation actually does.
    const first = await send(build(1, count));
    await pause();
    const slide = Number(process.argv[5] ?? 5);
    const second = anchored ? await send(build(1, count + slide)) : await send(build(1 + slide, count));
    spent += first.cost + second.cost;
    const share = second.prompt > 0 ? Math.round((second.cached / second.prompt) * 100) : 0;
    console.log(`${label}:`);
    console.log(`  first reply : ${first.prompt} prompt, ${first.cached} cached`);
    console.log(`  two later   : ${second.prompt} prompt, ${second.cached} cached (${share}% of it)\n`);
  }
  console.log(`$${spent.toFixed(5)} spent`);
};

void main();
