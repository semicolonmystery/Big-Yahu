/**
 * The two ways a model call fails that the channel is told about. Shared by
 * every path that calls a model, so the reply pipeline can tell them apart
 * whichever path threw.
 */

/** Thrown once every model on a list has been tried and none answered. */
export class OverloadedError extends Error {
  readonly attempts: number;
  readonly triedModels: string[];

  constructor(triedModels: string[], cause: unknown) {
    super(`No chat model answered after trying ${triedModels.join(', ') || 'none'}`, { cause });
    this.name = 'OverloadedError';
    this.attempts = triedModels.length;
    this.triedModels = triedModels;
  }
}

/**
 * The key cannot pay, so no model behind it can answer.
 *
 * Thrown instead of walking the rest of the list: every model shares the key,
 * so the next one is guaranteed to fail the same way, several seconds later.
 * It is also not the model's fault, so nothing is recorded against it.
 */
export class BillingError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`The AI key cannot pay for this request: ${detail}`);
    this.name = 'BillingError';
    this.detail = detail;
  }
}
