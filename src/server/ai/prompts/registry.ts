import {
  FACT_EXTRACTION_DEFAULT,
  REPLY_DEFAULT,
  SAFETY_FLOOR,
  TOPIC_EXTRACTION_DEFAULT,
} from './systemInstructions';

/** The prompts an operator can rewrite. */
export const PROMPT_IDS = ['factExtraction', 'topicExtraction', 'reply'] as const;
export type PromptId = (typeof PROMPT_IDS)[number];

/**
 * A prompt's shipped text and what it cannot be written without.
 *
 * `required` is the whole reason saving can fail. The bot substitutes these at
 * call time, so a prompt that drops `{{now}}` does not error — it just leaves
 * the model with no idea what day it is, and every relative date it resolves
 * from then on is wrong in a way nobody notices for weeks. Refusing the save is
 * the only point where that is still cheap to catch.
 */
export interface PromptDefinition {
  id: PromptId;
  label: string;
  description: string;
  fallback: string;
  required: readonly string[];
  /** Appended after the operator's text and not editable. Only the reply prompt has one. */
  floor?: string;
}

export const PROMPTS: Record<PromptId, PromptDefinition> = {
  factExtraction: {
    id: 'factExtraction',
    label: 'Fact extraction',
    description: 'Run over each channel on a timer. Decides what is worth remembering, and writes it.',
    fallback: FACT_EXTRACTION_DEFAULT,
    required: ['now'],
  },
  topicExtraction: {
    id: 'topicExtraction',
    label: 'Topic extraction',
    description:
      'The first of the two calls behind a reply. Works out what is being discussed, and becomes the '
      + 'search query that pulls memories back.',
    fallback: TOPIC_EXTRACTION_DEFAULT,
    required: [],
  },
  reply: {
    id: 'reply',
    label: 'Reply',
    description: "The bot's voice and its rules for answering. The longest of the three by far.",
    fallback: REPLY_DEFAULT,
    required: ['now', 'language', 'guildId'],
    floor: SAFETY_FLOOR,
  },
};

/** Generous, but not unbounded: the shipped reply prompt is around 12 KB. */
export const MAX_PROMPT_BYTES = 64 * 1024;

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

export function placeholdersIn(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

/** Why this prompt cannot be saved, or null when it can. */
export function promptRejection(id: PromptId, body: string): string | null {
  if (!body.trim()) return 'A prompt cannot be empty. Reset it instead to go back to the shipped one.';
  if (Buffer.byteLength(body, 'utf8') > MAX_PROMPT_BYTES) {
    return `A prompt must be under ${MAX_PROMPT_BYTES / 1024} KB.`;
  }

  const present = new Set(placeholdersIn(body));
  const missing = PROMPTS[id].required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    return `This prompt still needs ${missing.map((name) => `{{${name}}}`).join(' and ')}. `
      + 'Without it the bot loses what that value carries — put it back somewhere in the text.';
  }

  const known = new Set(PROMPTS[id].required);
  const unknown = [...present].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return `Nothing will replace ${unknown.map((name) => `{{${name}}}`).join(', ')}, so it would reach `
      + `the model as written. This prompt substitutes ${
        PROMPTS[id].required.length > 0
          ? PROMPTS[id].required.map((name) => `{{${name}}}`).join(', ')
          : 'nothing'
      }.`;
  }

  return null;
}

/**
 * Substitute, then append the floor.
 *
 * The floor goes last and is not part of the editable body, so no amount of
 * rewriting — including uploading a file that simply omits it — removes it.
 */
export function renderPrompt(id: PromptId, body: string, values: Record<string, string>): string {
  const substituted = body.replace(PLACEHOLDER, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name] : whole);
  const floor = PROMPTS[id].floor;
  return floor ? `${substituted}\n\n${floor}` : substituted;
}
