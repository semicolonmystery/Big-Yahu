import { effectivePrompt } from '../../db/repositories/promptsRepo';

/**
 * What the model is actually given.
 *
 * Read per call rather than cached: an operator editing a prompt in the panel
 * expects the next reply to use it, and these are three cheap reads against a
 * local SQLite file next to a model round trip.
 */
export function buildFactExtractionInstruction(): string {
  return effectivePrompt('factExtraction');
}

export function buildTopicExtractionInstruction(): string {
  return effectivePrompt('topicExtraction');
}

export function buildReplyInstruction(): string {
  return effectivePrompt('reply');
}
