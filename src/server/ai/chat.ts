import type OpenAI from 'openai';
import { openrouter, routingFor } from './openrouter';
import { recordCall } from './usage';
import { claimAIRequest } from './requestBudget';
import { runOnPool, type PoolCandidate } from './pool';
import { reasoningEffortFor } from '../db/repositories/aiTasksRepo';
import { recordTaskSuccess } from '../db/repositories/taskModelsRepo';
import type { MessageImage } from '../bot/attachments';

/** A tool as the model is offered it. Plain JSON Schema, whoever serves the model. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export interface ChatRequest {
  /** The operator's prompt, sent exactly as saved, plus whatever plugins add. */
  system: string;
  /** The conversation so far, the material first. */
  messages: ChatMessage[];
  tools?: ToolDeclaration[];
  /** `none` on the last turn, so the model has to answer rather than call something else. */
  toolChoice?: 'auto' | 'none';
  /** There are pictures in `messages`, so image-capable models are tried first. */
  hasImages?: boolean;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatAnswer {
  /**
   * The model's turn exactly as it arrived, to be pushed back into `messages`.
   * It carries the reasoning the provider requires to be echoed unchanged, so a
   * rebuilt copy is refused.
   */
  message: ChatMessage;
  text: string;
  toolCalls: ChatToolCall[];
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

const NOT_SHOWN = 'The pictures mentioned above could not be sent to you. Treat every one of them as not shown, '
  + 'and never guess at what was in them.';

/** The material, with the pictures from this conversation attached to it. */
export function userMessageWithImages(text: string, images: MessageImage[]): ChatMessage {
  if (images.length === 0) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      })),
    ],
  };
}

/** The same conversation with every picture taken out, for a model that cannot see them. */
function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    return { role: 'user', content: `${text}\n\n${NOT_SHOWN}` };
  });
}

function readToolCalls(message: OpenAI.Chat.ChatCompletionMessage): ChatToolCall[] {
  return (message.tool_calls ?? []).flatMap((call) => {
    if (call.type !== 'function') return [];
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // A tool called with arguments that will not parse is answered as a tool
      // with no arguments, which its own validation then refuses plainly.
    }
    return [{ id: call.id, name: call.function.name, args }];
  });
}

/**
 * One turn of a conversation with tools, on a task's model list.
 *
 * How hard the model may think is the task's own setting, so the reply can be
 * made to reason without touching anything else. Everything about failing over
 * between models lives in the pool.
 */
export async function chat(task: string, request: ChatRequest): Promise<ChatAnswer> {
  const effort = reasoningEffortFor(task);

  return runOnPool<ChatAnswer>(task, {
    withImages: request.hasImages,
    signal: request.signal,
    attempt: async (candidate: PoolCandidate) => {
      const deadline = claimAIRequest();
      const signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
      const startedAt = Date.now();
      const messages = candidate.sendImages ? request.messages : withoutImages(request.messages);
      const params = {
        model: candidate.model,
        messages: [{ role: 'system' as const, content: request.system }, ...messages],
        ...(request.tools?.length
          ? {
            tools: request.tools.map((tool) => ({
              type: 'function' as const,
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
            tool_choice: request.toolChoice ?? 'auto',
          }
          : {}),
        max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        reasoning: { effort },
        provider: routingFor(candidate.upstream),
      };

      let response: OpenAI.Chat.ChatCompletion;
      try {
        response = await openrouter().chat.completions.create(
          params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          { signal },
        );
      } catch (error) {
        recordCall({ task, model: candidate.model, startedAt, outcome: 'error' });
        throw error;
      }
      recordCall({ task, model: candidate.model, startedAt, response: response as { usage?: unknown }, outcome: 'ok' });
      recordTaskSuccess(task, candidate.model);

      const message = response.choices[0]?.message;
      if (!message) throw new Error(`${candidate.model} answered with no message at all`);
      return {
        message: message as ChatMessage,
        text: (message.content ?? '').trim(),
        toolCalls: readToolCalls(message),
      };
    },
  });
}
