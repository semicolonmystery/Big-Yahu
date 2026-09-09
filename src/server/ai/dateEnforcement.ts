import { Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { generate } from './generate';
import { getSettings } from '../db/repositories/settingsRepo';
import { formatNow } from '@shared/constants';
import { hasRelativeDate } from './relativeDates';

/**
 * A fact saying "the meeting moved to tomorrow" is worthless the day after it is
 * written, and both write paths were only *asked* not to do it. Asking was not
 * enough, exactly as it was not enough for `<@id>` mentions, so this is the
 * enforcement half: detect it, and spend one model call putting it right.
 */

/**
 * Quoted runs are left alone. A fact quotes someone verbatim when the wording is
 * the point, and rewriting inside the quotes would change what they said.
 * Same convention as `mentionifyNames` in `@shared/discord`.
 */
const QUOTED_SPAN = /"[^"]*"|“[^”]*”|`[^`]*`/g;

export function hasUnresolvedRelativeDate(text: string): boolean {
  // Stripped rather than skipped over: a quotation is verbatim by design, and
  // "zitra" inside quotes is someone being quoted, not a date to resolve.
  return hasRelativeDate(text.replace(QUOTED_SPAN, ' '));
}

const resolvedSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    facts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER, description: 'The index of the fact, exactly as given to you.' },
          text: { type: Type.STRING, description: 'The same fact with every relative date replaced by a real one.' },
        },
        required: ['index', 'text'],
      },
    },
  },
  required: ['facts'],
};

const INSTRUCTION = `You rewrite stored facts so they still make sense months from now.

Each fact below is followed by the time it was written. Some of them say "tomorrow", "zítra", "next Friday", "za tejden" or similar. Those are meaningless once the day passes.

For each one, work the real date out from the time that fact was written and replace the relative expression with it.

The format is fixed and never varies: day.month.year. "10.9.2026" is the tenth of September 2026. Never write it the American way round, never write it as 2026-09-10, and never spell the month out. Where a time was given, it goes after the date: "10.9.2026 21:00". Where only a day is meant, the date on its own is enough.

Change nothing else. Keep the wording, keep every <@ID> mention exactly as it is, keep anything inside double quotes exactly as it is — even if what is inside the quotes is itself a relative date, because that is someone being quoted. The fact stays in English.

If a fact genuinely has no relative date in it, return it unchanged.`;

export interface DatedText {
  text: string;
  /** When the fact was written, which is what "tomorrow" was relative to. */
  anchor: number;
}

/**
 * One corrective call over only the facts that tripped the detector. Everything
 * else is left untouched, and a failure returns the originals: a fact with a
 * fuzzy date in it is worth more than no fact at all.
 */
export async function resolveRelativeDates(items: DatedText[]): Promise<string[]> {
  if (items.length === 0) return [];

  const settings = getSettings();
  const listing = items
    .map((item, index) => `[${index}] written ${formatNow(settings.timezone, new Date(item.anchor))}\n${item.text}`)
    .join('\n\n');

  try {
    const response = await generate(`Facts to fix:\n\n${listing}`, {
      systemInstruction: `${INSTRUCTION}\n\nRight now it is ${formatNow(settings.timezone)}.`,
      responseMimeType: 'application/json',
      responseSchema: resolvedSchema,
    });

    const parsed = JSON.parse(response.text ?? '{}') as { facts?: Array<{ index?: unknown; text?: unknown }> };
    const resolved = items.map((item) => item.text);
    for (const entry of parsed.facts ?? []) {
      const index = typeof entry.index === 'number' ? entry.index : Number.NaN;
      if (!Number.isInteger(index) || index < 0 || index >= resolved.length) continue;
      if (typeof entry.text === 'string' && entry.text.trim()) resolved[index] = entry.text.trim();
    }
    return resolved;
  } catch (error) {
    console.warn('[facts] could not resolve relative dates, storing them as written:', error);
    return items.map((item) => item.text);
  }
}
