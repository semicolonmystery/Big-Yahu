import { Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { generate } from './generate';

const REWRITE_INSTRUCTION = `You turn a search query into the kind of sentence a stored fact is written as.

The store holds standalone statements about a Discord server — what people did, decided, like, said, agreed. A query is usually a fragment or a question, which embeds poorly against statements like those.

Rewrite it as one or two plain statements of the thing being looked for, in the same language as the query. Keep every name, place and specific term exactly as written; they carry most of the meaning. Add nothing that was not asked for, and do not answer the question.

Mentions — <@123456> for a person, <#123456> for a channel — are carried through untouched, alongside the name they appear with. Stored facts refer to people by mention and questions refer to them by name, so dropping either half throws away one of the two ways the thing can be found. Never turn a mention into a name or a name into a mention; keep both.

"kde bydli tomas <@123456>" becomes "Tomáš <@123456> bydlí. Tomášovo <@123456> bydliště." — the shape of the fact, not a guess at its content.`;

const rewriteSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    rewritten: { type: Type.STRING, description: 'The query restated as fact-shaped statements.' },
  },
  required: ['rewritten'],
};

/**
 * Questions embed poorly against declarative facts, so the query is restated in
 * the shape of a stored fact before it is embedded. Falls back to the original
 * query if the rewrite fails — a worse search beats no search.
 */
export async function rewriteForFactSearch(query: string): Promise<string> {
  try {
    const response = await generate(`Query: ${query}`, {
      systemInstruction: REWRITE_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: rewriteSchema,
    });
    const parsed = JSON.parse(response.text ?? '{}') as { rewritten?: unknown };
    const rewritten = typeof parsed.rewritten === 'string' ? parsed.rewritten.trim() : '';
    return rewritten || query;
  } catch (error) {
    console.warn('[ai] fact-search query rewrite failed, using the raw query:', error);
    return query;
  }
}
