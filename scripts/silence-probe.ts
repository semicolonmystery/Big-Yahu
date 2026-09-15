/**
 * What the silence rule actually does, asked of a real model.
 *
 * A prompt change cannot be unit-tested — the tests can only check that the
 * words are in the file. This asks an actual model the cases that have gone
 * wrong in the channel and says which way each went, so a rewrite can be
 * checked before it reaches anybody. Run it against the old prompt and the new
 * one to see whether a change did what it was meant to.
 *
 *   npx tsx scripts/silence-probe.ts [model]
 *
 * It costs real money — about a cent a run on flash-lite — so it is never part
 * of `npm run check` and nothing calls it on its own. The key is never read
 * here: dotenv puts it in the environment and the SDK takes it from there.
 */
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { TOPIC_EXTRACTION_DEFAULT } from '../src/server/ai/prompts/systemInstructions';
import { topicSchemaFor } from '../src/server/ai/schemas';
import { formatInstruction } from '../src/server/ai/structured';

dotenv.config();

const MODEL = process.argv[2] ?? 'google/gemini-3.5-flash-lite';
const TYPES = ['rule', 'person', 'preference', 'event', 'decision', 'message', 'info'];
const BOT = '1546181702689357954';
const ME = '874561728921370654';

interface Line { id: string; at: string; authorId: string; content: string }

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 15, 8, minutes)).toISOString();

/** Each case: the window, and whether a reply is the right answer. */
const CASES: Array<{ name: string; shouldAnswer: boolean; messages: Line[] }> = [
  {
    name: 'welcomed back',
    shouldAnswer: true,
    messages: [{ id: '1', at: at(0), authorId: ME, content: `<@${BOT}> welcome back 👋` }],
  },
  {
    name: 'thanks, after it answered',
    shouldAnswer: false,
    messages: [
      { id: '1', at: at(0), authorId: ME, content: 'jak se dela tar archiv' },
      { id: '2', at: at(1), authorId: 'you', content: 'tar -czf neco.tar.gz slozka/' },
      { id: '3', at: at(2), authorId: ME, content: `dik, mel jsi pravdu synu <@${BOT}>` },
    ],
  },
  {
    name: 'asked to go and talk to somebody',
    shouldAnswer: true,
    messages: [{ id: '1', at: at(0), authorId: ME, content: `synu povidej si s kubou <@333> <@${BOT}>` }],
  },
  {
    name: 'chased after being ignored',
    shouldAnswer: true,
    messages: [
      { id: '1', at: at(0), authorId: ME, content: `synu povidej si s kubou <@${BOT}>` },
      { id: '2', at: at(6), authorId: ME, content: `tak si povidej ne <@${BOT}>` },
      { id: '3', at: at(8), authorId: ME, content: `odpovez mi zmrde <@${BOT}>` },
    ],
  },
  {
    name: 'a trap whose whole point is the reply',
    shouldAnswer: false,
    messages: [{ id: '1', at: at(0), authorId: ME, content: `debil rekne co <@${BOT}>` }],
  },
  {
    name: 'a plain question',
    shouldAnswer: true,
    messages: [{ id: '1', at: at(0), authorId: ME, content: `<@${BOT}> co je to inode` }],
  },
  {
    name: 'told something, no question',
    shouldAnswer: true,
    messages: [{ id: '1', at: at(0), authorId: ME, content: `<@${BOT}> zitra jedu na chatu` }],
  },
  {
    name: 'ok, closing an exchange',
    shouldAnswer: false,
    messages: [
      { id: '1', at: at(0), authorId: ME, content: 'kdy je ten deadline' },
      { id: '2', at: at(1), authorId: 'you', content: 'v patek' },
      { id: '3', at: at(2), authorId: ME, content: `ok <@${BOT}>` },
    ],
  },
];

const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0 });

async function ask(messages: Line[]): Promise<{ staySilent: boolean; about: string; cost: number }> {
  const material = JSON.stringify({
    now: '15.9.2026 08:30',
    task: 'Work out what is being asked.',
    channelId: '1547015084910452756',
    taggingMessageId: messages[messages.length - 1].id,
    messages,
  });
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: TOPIC_EXTRACTION_DEFAULT },
      { role: 'system', content: formatInstruction(topicSchemaFor(TYPES)) },
      { role: 'user', content: material },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 2048,
  } as never);
  const raw = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as { staySilent?: boolean; whatTaggingMessageIsAbout?: string };
  const usage = response.usage as { cost?: number } | undefined;
  return {
    staySilent: parsed.staySilent === true,
    about: parsed.whatTaggingMessageIsAbout ?? '',
    cost: usage?.cost ?? 0,
  };
}

const main = async (): Promise<void> => {
  let spent = 0;
  let wrong = 0;
  console.log(`model: ${MODEL}\n`);
  for (const testCase of CASES) {
    try {
      const answer = await ask(testCase.messages);
      spent += answer.cost;
      const answered = !answer.staySilent;
      const ok = answered === testCase.shouldAnswer;
      if (!ok) wrong += 1;
      console.log(`${ok ? 'ok  ' : 'WRONG'}  ${testCase.name}`);
      console.log(`       wanted ${testCase.shouldAnswer ? 'a reply' : 'silence'}, got ${answered ? 'a reply' : 'silence'}`);
      console.log(`       it read it as: ${answer.about.slice(0, 140)}\n`);
    } catch (error) {
      console.log(`ERROR  ${testCase.name}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  console.log(`${CASES.length - wrong}/${CASES.length} right, $${spent.toFixed(5)} spent`);
};

void main();
