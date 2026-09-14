import {
  FACT_CLEANUP_DEFAULT,
  FACT_EXTRACTION_DEFAULT,
  REPLY_DEFAULT,
  TOPIC_EXTRACTION_DEFAULT,
} from './systemInstructions';

/** The prompts an operator can rewrite. */
export const PROMPT_IDS = ['factExtraction', 'topicExtraction', 'reply', 'factCleanup'] as const;
export type PromptId = (typeof PROMPT_IDS)[number];

/**
 * A prompt's shipped text.
 *
 * Nothing is substituted into it. The time, the language, who is asking and
 * everything else the model needs travels in the material beside the prompt, so
 * a prompt is identical from call to call and the provider can cache it. What
 * an operator saves is handed over exactly as written — including any
 * `{{braces}}` they type, which are simply text nothing will ever fill.
 */
export interface PromptDefinition {
  id: PromptId;
  label: string;
  description: string;
  fallback: string;
}

export const PROMPTS: Record<PromptId, PromptDefinition> = {
  factExtraction: {
    id: 'factExtraction',
    label: 'Fact extraction',
    description: 'Run over each channel on a timer. Decides what is worth remembering, and writes it.',
    fallback: FACT_EXTRACTION_DEFAULT,
  },
  topicExtraction: {
    id: 'topicExtraction',
    label: 'Topic extraction',
    description:
      'The first of the two calls behind a reply. Works out what is being discussed, and becomes the '
      + 'search query that pulls memories back.',
    fallback: TOPIC_EXTRACTION_DEFAULT,
  },
  reply: {
    id: 'reply',
    label: 'Reply',
    description: "The bot's voice and its rules for answering. The longest of them by far.",
    fallback: REPLY_DEFAULT,
  },
  factCleanup: {
    id: 'factCleanup',
    label: 'Fact cleanup',
    description:
      'The one-off pass over facts stored before the rules changed. Rewrites fuzzy dates, invented '
      + 'timings and display names, and sorts each fact into types. Run from Settings, never on its own.',
    fallback: FACT_CLEANUP_DEFAULT,
  },
};

/** Generous, but not unbounded: the shipped reply prompt is around 12 KB. */
export const MAX_PROMPT_BYTES = 64 * 1024;

/**
 * Notation from before the material became JSON: bracket markers that no longer
 * appear anywhere, and the time placeholder that is now a field. A saved prompt
 * still describing those is telling the model to look for things that are not
 * there, so the panel says so rather than letting it quietly misfire.
 */
const OLD_FORMAT = /\[id=|\[replying to id=|\[factId=|\[image not shown\]|\{\{\s*now\s*\}\}/;

export function describesOldFormat(body: string): boolean {
  return OLD_FORMAT.test(body);
}

/**
 * Why this prompt cannot be saved, or null when it can.
 *
 * Only two things are refused: nothing at all, and something too big to be a
 * prompt. What it says is the operator's business — the model gets it verbatim.
 */
export function promptRejection(_id: PromptId, body: string): string | null {
  if (!body.trim()) return 'A prompt cannot be empty. Reset it instead to go back to the shipped one.';
  if (Buffer.byteLength(body, 'utf8') > MAX_PROMPT_BYTES) {
    return `A prompt must be under ${MAX_PROMPT_BYTES / 1024} KB.`;
  }
  return null;
}
