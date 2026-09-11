import { effectivePrompt } from '../../db/repositories/promptsRepo';
import { renderPrompt } from './registry';

/**
 * What the model is actually given.
 *
 * Read per call rather than cached: an operator editing a prompt in the panel
 * expects the next reply to use it, and these are three cheap reads against a
 * local SQLite file next to two Gemini round trips.
 */
export function buildFactExtractionInstruction(now: string): string {
  return renderPrompt(effectivePrompt('factExtraction'), { now });
}

export function buildTopicExtractionInstruction(): string {
  return renderPrompt(effectivePrompt('topicExtraction'), {});
}

export function buildReplyInstruction(guildId: string, language: string, now: string): string {
  return renderPrompt(effectivePrompt('reply'), { guildId, language, now });
}
