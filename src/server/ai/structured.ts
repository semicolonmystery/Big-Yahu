import type OpenAI from 'openai';
import { routingFor } from './openrouter';
import { completeWithReasoning } from './reasoning';
import { schemaViolation, type JsonSchema } from './jsonSchema';
import { recordCall } from './usage';
import { claimAIRequest } from './requestBudget';
import { runOnPool, type PoolCandidate } from './pool';
import { recordTaskSuccess } from '../db/repositories/taskModelsRepo';
import type { MessageImage } from '../bot/attachments';

/** What a caller gets when it asks for nothing in particular. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** The bound on any one answer, so a runaway cannot bill forever. The ceiling, not the size. */
const MAX_OUTPUT_TOKENS_CEILING = 65_536;

/** An answer that could not be read, and whether a shorter window might be. */
export class UnreadableAnswerError extends Error {
  readonly truncated: boolean;

  constructor(message: string, truncated: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = 'UnreadableAnswerError';
    this.truncated = truncated;
  }
}

export interface StructuredRequest {
  /** The operator's prompt, sent exactly as saved. */
  system: string;
  /** The task and the material to work from. */
  user: string;
  images?: MessageImage[];
  schema: JsonSchema;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

type Message = OpenAI.Chat.ChatCompletionMessageParam;

interface Answer {
  raw: string;
  value: unknown;
  truncated: boolean;
}

/**
 * The answer's shape, as a message of its own. JSON mode guarantees JSON but
 * not which JSON, so the shape has to be said — and it is said here, after the
 * operator's prompt rather than inside it. What an operator saves is still
 * precisely the first thing the model reads.
 */
export function formatInstruction(schema: JsonSchema): string {
  return 'Answer with one JSON object and nothing else: no prose before or after it, and no code fence. '
    + 'It must match this JSON Schema exactly. Every property listed is required and no other property is '
    + 'allowed. When a string has nothing to say, give an empty string; when a list has nothing in it, give an '
    + `empty array.\n${JSON.stringify(schema)}`;
}

const NOT_SHOWN = 'The pictures mentioned above could not be sent to you. Treat every one of them as not shown, '
  + 'and never guess at what was in them.';

function userMessage(request: StructuredRequest, sendImages: boolean): Message {
  const images = request.images ?? [];
  if (images.length === 0) return { role: 'user', content: request.user };
  if (!sendImages) return { role: 'user', content: `${request.user}\n\n${NOT_SHOWN}` };
  return {
    role: 'user',
    content: [
      { type: 'text', text: request.user },
      ...images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      })),
    ],
  };
}

async function complete(task: string, candidate: PoolCandidate, messages: Message[], request: StructuredRequest): Promise<Answer> {
  const deadline = claimAIRequest();
  const signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
  const startedAt = Date.now();
  // `provider` is OpenRouter's own field; the SDK passes it through as it is.
  // `reasoning` is added by `completeWithReasoning`, which owns the effort and
  // the endpoints that will not have it switched off.
  const params = {
    model: candidate.model,
    messages,
    response_format: { type: 'json_object' as const },
    max_tokens: Math.min(request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_CEILING),
    provider: routingFor(candidate.upstream),
  };

  let response: OpenAI.Chat.ChatCompletion;
  try {
    response = await completeWithReasoning(task, candidate, params, { signal });
  } catch (error) {
    recordCall({ task, model: candidate.model, startedAt, outcome: 'error' });
    throw error;
  }
  recordCall({ task, model: candidate.model, startedAt, response: response as { usage?: unknown }, outcome: 'ok' });
  recordTaskSuccess(task, candidate.model);

  const choice = response.choices[0];
  const raw = choice?.message?.content ?? '';
  let value: unknown;
  try {
    value = raw.trim() ? JSON.parse(raw) : undefined;
  } catch {
    value = undefined;
  }
  return { raw, value, truncated: choice?.finish_reason === 'length' };
}

function problemWith(answer: Answer, schema: JsonSchema): string | null {
  if (!answer.raw.trim()) return 'the answer was empty';
  if (answer.value === undefined) return 'the answer was not valid JSON';
  return schemaViolation(schema, answer.value);
}

/**
 * One model, asked once, and asked again once if the shape was wrong, with the
 * problem quoted: a shape mistake is almost always fixed on the second go. A
 * truncated answer is not asked again — the same window would run out the same
 * way — and goes back to the caller, which narrows the window instead.
 */
async function askModel<T>(task: string, candidate: PoolCandidate, request: StructuredRequest): Promise<T> {
  const messages: Message[] = [
    { role: 'system', content: request.system },
    { role: 'system', content: formatInstruction(request.schema) },
    userMessage(request, candidate.sendImages),
  ];

  let answer = await complete(task, candidate, messages, request);
  for (let attempt = 0; ; attempt += 1) {
    if (answer.truncated) {
      throw new UnreadableAnswerError(`${candidate.model} ran out of output budget after ${answer.raw.length} characters`, true);
    }
    const problem = problemWith(answer, request.schema);
    if (!problem) return answer.value as T;
    if (attempt >= 1) {
      console.error(`[ai] ${task}: ${candidate.model} answered in the wrong shape twice (${problem}); it began: ${answer.raw.slice(0, 300)}`);
      throw new UnreadableAnswerError(`${candidate.model} twice answered in the wrong shape: ${problem}`, false);
    }
    console.warn(`[ai] ${task}: ${candidate.model} answered in the wrong shape (${problem}), asking once more`);
    messages.push(
      { role: 'assistant', content: answer.raw || '(empty)' },
      { role: 'user', content: `That answer does not fit: ${problem}. Answer again with one JSON object that matches the schema exactly.` },
    );
    answer = await complete(task, candidate, messages, request);
  }
}

/**
 * Asks a task's model list for an answer in a known shape.
 *
 * Walks the list best first, moving to the next model when one fails
 * transiently rather than hammering the same one. A model that keeps failing is
 * rested by the repository; one OpenRouter says does not exist is retired from
 * every list; an empty wallet stops everything at once. Bad requests are not a
 * model's fault and fail immediately.
 */
export async function structured<T>(task: string, request: StructuredRequest): Promise<T> {
  return runOnPool<T>(task, {
    withImages: (request.images?.length ?? 0) > 0,
    signal: request.signal,
    // The model answered; what it said could not be used. Narrowing the window
    // is the caller's move, not another model's problem.
    rethrow: (error) => error instanceof UnreadableAnswerError,
    attempt: (candidate) => askModel<T>(task, candidate, request),
  });
}
