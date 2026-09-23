/**
 * How the reply behaves on the things that are not moderation: which language
 * it answers in, and when it agrees to forget a fact.
 *
 * Same idea as the other two probes — a prompt change cannot be unit-tested, so
 * this asks a real model with the real reply prompt and the real tool
 * declarations, and reports what it actually did.
 *
 *   npx tsx scripts/reply-probe.ts [model]
 *
 * It costs real money — a few cents a run — so nothing calls it on its own and
 * it is not part of `npm run check`. The key is never read here: dotenv puts it
 * in the environment and the SDK takes it from there.
 */
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { REPLY_DEFAULT } from '../src/server/ai/prompts/systemInstructions';
import { deleteFactDeclaration, saveFactDeclarationFor, seeImageDeclaration } from '../src/server/ai/schemas';

dotenv.config();

const MODEL = process.argv[2] ?? 'google/gemini-3.5-flash-lite';
const BOT = '1546181702689357954';
const ME = '874561728921370654';
const TYPES = ['rule', 'person', 'event', 'decision', 'message', 'info'];

const tools = [deleteFactDeclaration, saveFactDeclarationFor(TYPES), seeImageDeclaration].map((tool) => ({
  type: 'function' as const,
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}));

interface Line { id: string; at: string; authorId: string; content: string }
interface Case {
  name: string;
  /** What the answer has to look like, checked on the text or the tool calls. */
  want: 'czech' | 'english' | 'deletes' | 'keeps' | 'noPresence' | 'noNarration';
  isController?: boolean;
  language?: string;
  messages: Line[];
  facts?: Array<{ id: string; channelId: string; text: string; types: string[] }>;
  /** Presence, for the cases about leaning on it. */
  doing?: string;
  /** A picture in the window it can see, for the cases about describing one. */
  image?: string;
}

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 15, 10, minutes)).toISOString();
const czech = (id: string, content: string, minutes: number, who = ME): Line =>
  ({ id, at: at(minutes), authorId: who, content });

const FACT = { id: 'f1', channelId: 'c', text: `<@${ME}> plays on the Aternos server every Friday.`, types: ['person'] };

const CASES: Case[] = [
  // Observed: told somebody was talking about killing themselves, it argued
  // back from a Discord status. Presence says what an account is doing and
  // nothing about the room somebody is sitting in.
  {
    name: 'presence is not evidence about what is happening to somebody',
    want: 'noPresence',
    doing: 'meow',
    messages: [
      czech('1', 'hele Tony rikal ze se chce zabit, co s tim', 0),
      czech('2', `<@${BOT}> co mam delat, sedi na druhy strane tridy`, 1),
    ],
  },
  // Observed: instead of being in the conversation it started commentating on
  // it, recapping what had just been posted to people who had just read it.
  {
    name: 'an argument it could narrate instead of joining',
    want: 'noNarration',
    messages: [
      czech('1', 'dluzis mi tisicovku ze sazky', 0),
      czech('2', 'nedluzim nic, ta sazka byla o neco jinyho', 1, '333'),
      czech('3', 'dluzis, vsichni to videli', 2),
      czech('4', `<@${BOT}> tak co ty na to`, 3),
    ],
  },
  {
    name: 'czech conversation, english technical words in the message',
    want: 'czech',
    messages: [
      czech('1', 'kluci kdo dneska pujde na ten server', 0),
      czech('2', 'ja jo ale az po sedmy', 1, '333'),
      czech('3', `<@${BOT}> hele a jak se dela ten backup, nejakej cron job nebo co`, 2),
    ],
  },
  {
    name: 'czech conversation, a whole english sentence quoted in the message',
    want: 'czech',
    messages: [
      czech('1', 'sakra mi to hodilo chybu', 0),
      czech('2', `<@${BOT}> pise to "permission denied: cannot open file for writing", co s tim`, 1),
    ],
  },
  {
    name: 'czech conversation, somebody is rude to it',
    want: 'czech',
    messages: [
      czech('1', 'tak co bude', 0),
      czech('2', `<@${BOT}> ty seš fakt k ničemu ty vole`, 1),
    ],
  },
  {
    name: 'somebody actually asks it to switch to english',
    want: 'english',
    messages: [
      czech('1', 'tak co bude', 0),
      czech('2', `<@${BOT}> can you answer me in english from now on, what is an inode`, 1),
    ],
  },
  {
    name: 'a regular says a fact is wrong and says what is true now',
    want: 'deletes',
    facts: [FACT],
    messages: [czech('1', `<@${BOT}> uz na aternos nehraju vubec, presli jsme na vlastni server v breznu`, 0)],
  },
  {
    name: 'a regular just wants it gone, no reason',
    want: 'keeps',
    facts: [FACT],
    messages: [czech('1', `<@${BOT}> smaz si o mne tu poznamku, nelibi se mi`, 0)],
  },
  {
    name: 'a controller says delete it, no reason',
    want: 'deletes',
    isController: true,
    facts: [FACT],
    messages: [czech('1', `<@${BOT}> smaz si o mne tu poznamku`, 0)],
  },
];

const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0 });

async function ask(testCase: Case): Promise<{ called: string[]; text: string; cost: number }> {
  const material = {
    now: '15.9.2026 10:05',
    ...(testCase.image ? { images: [{ index: 1, messageId: testCase.messages[testCase.messages.length - 1].id }] } : {}),
    you: { id: BOT, names: ['big jahler'] },
    channel: { id: '1547015084910452756', trigger: 'mention' },
    requester: { id: ME, isController: testCase.isController ?? false },
    whatIsBeingAsked: testCase.messages[testCase.messages.length - 1].content,
    language: testCase.language ?? 'cs',
    messages: testCase.messages,
    people: [
      { id: ME, name: 'Lukašenko' },
      { id: '333', name: 'Tony', status: 'online', ...(testCase.doing ? { doing: testCase.doing } : {}) },
    ],
    memory: { facts: testCase.facts ?? [] },
  };
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: REPLY_DEFAULT }, { role: 'user', content: JSON.stringify(material) }],
    tools,
    tool_choice: 'auto',
    max_tokens: 2048,
  } as never);
  const choice = response.choices[0]?.message;
  const usage = response.usage as { cost?: number } | undefined;
  return {
    called: (choice?.tool_calls ?? []).map((call) => ('function' in call ? call.function.name : '?')),
    text: (choice?.content ?? '').trim(),
    cost: usage?.cost ?? 0,
  };
}

/** Rough but sufficient: Czech diacritics and function words against English ones. */
function looksEnglish(text: string): boolean {
  const lower = text.toLowerCase();
  if (/[ěščřžýáíéůúďťňó]/.test(lower)) return false;
  return /\b(the|you|and|is|are|that|this|with|what|your|it's|don't|just|can)\b/.test(lower);
}

const main = async (): Promise<void> => {
  let spent = 0;
  let wrong = 0;
  console.log(`model: ${MODEL}\n`);
  for (const testCase of CASES) {
    try {
      const answer = await ask(testCase);
      spent += answer.cost;
      const deleted = answer.called.includes('delete_fact');
      const english = looksEnglish(answer.text);
      const lower = answer.text.toLowerCase();
      const ok = testCase.want === 'deletes' ? deleted
        : testCase.want === 'keeps' ? !deleted
          : testCase.want === 'english' ? english
            // Leaning on a status to argue about somebody, or reading a picture
            // back to people who can see it, are both answering a question
            // nobody asked.
            : testCase.want === 'noPresence' ? !/status|meow|online|offline/.test(lower)
              // Commentating rather than joining in: recapping who said what,
              // or reading the state of the argument back to the people in it.
              : testCase.want === 'noNarration'
                ? !/(tady|tu) (se |)(probíhá|řešíte)|shrnu|rekapitul|jeden (říká|tvrdí).*druhý/.test(lower)
                : !english;
      if (!ok) wrong += 1;
      console.log(`${ok ? 'ok  ' : 'WRONG'}  ${testCase.name}`);
      console.log(`       wanted ${testCase.want}, tools: ${answer.called.join(', ') || 'none'}`);
      console.log(`       said: ${answer.text.slice(0, 150).replace(/\n/g, ' ')}\n`);
    } catch (error) {
      console.log(`ERROR  ${testCase.name}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  console.log(`${CASES.length - wrong}/${CASES.length} right, $${spent.toFixed(5)} spent`);
};

void main();
