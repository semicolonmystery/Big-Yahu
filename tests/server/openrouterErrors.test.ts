import { describe, expect, it } from 'vitest';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import {
  classifyOpenRouterFailure,
  describeOpenRouterFailure,
  readOpenRouterFailure,
} from '../../src/server/ai/openrouterErrors';

// Bodies exactly as OpenRouter sent them during the 11.9.2026 probe. The SDK
// keeps the inner `error` object, which is what `generate` is handed here too.
const failure = (status: number, body: Record<string, unknown>) =>
  APIError.generate(status, { error: body }, undefined, new Headers());

const routingBlocked = failure(404, {
  message: '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy.',
  code: 404,
  metadata: {
    input_endpoint_count: 1,
    ineligibility_reasons: [{
      reason: 'paid-model-training-violation-by-account',
      endpoint_count: 1,
      configure_url: 'https://openrouter.ai/settings/privacy',
    }],
    failed_routing_step: 'Filter by Guardrails',
  },
});

const upstreamRefusal = failure(400, {
  message: 'Provider returned error',
  code: 400,
  metadata: {
    raw: '{"error":{"message":"Image in system message is unsupported","type":"invalid_request_error"}}',
    provider_name: 'DeepSeek',
    provider_error_code: 'invalid_request_error',
  },
});

describe('classifying OpenRouter failures', () => {
  it('treats running out of credit as the whole key being dead', () => {
    expect(classifyOpenRouterFailure(failure(402, { message: 'Insufficient credits', code: 402 }))).toBe('billing');
  });

  it('retires a model OpenRouter says does not exist, for chat and for embeddings', () => {
    expect(classifyOpenRouterFailure(failure(400, { message: 'deepseek/does-not-exist is not a valid model ID', code: 400 })))
      .toBe('gone');
    expect(classifyOpenRouterFailure(failure(400, { message: 'Model openai/does-not-exist does not exist', code: 400 })))
      .toBe('gone');
  });

  it('never retires a model because routing could not place it', () => {
    expect(classifyOpenRouterFailure(routingBlocked)).toBe('next-model');
    expect(readOpenRouterFailure(routingBlocked).blockedBy).toEqual([
      { reason: 'paid-model-training-violation-by-account', configureUrl: 'https://openrouter.ai/settings/privacy' },
    ]);
  });

  it('fails a request an upstream host rejected, rather than walking the whole pool into it', () => {
    expect(classifyOpenRouterFailure(upstreamRefusal)).toBe('fatal');
    expect(classifyOpenRouterFailure(failure(400, { message: 'Tool xyz does not exist', code: 400 }))).toBe('fatal');
  });

  // The request is retried without the field first; reaching the pool at all
  // means that endpoint will not answer on any terms, and another row may.
  it('moves on when an endpoint will not have reasoning switched off', () => {
    expect(classifyOpenRouterFailure(failure(400, {
      message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400,
    }))).toBe('next-model');
  });

  it('fails a bad key outright', () => {
    expect(classifyOpenRouterFailure(failure(401, { message: 'Missing Authentication header', code: 401 }))).toBe('fatal');
  });

  it.each([403, 408, 429, 500, 502, 503, 504])('moves on to the next model on %i', (status) => {
    expect(classifyOpenRouterFailure(failure(status, { message: 'unwell', code: status }))).toBe('next-model');
  });

  it('moves on when nothing was answered at all', () => {
    expect(classifyOpenRouterFailure(new APIConnectionError({ message: 'Connection error.' }))).toBe('next-model');
    expect(classifyOpenRouterFailure(new APIConnectionTimeoutError())).toBe('next-model');
    expect(classifyOpenRouterFailure(new APIUserAbortError())).toBe('next-model');
    expect(classifyOpenRouterFailure(new Error('fetch failed'))).toBe('next-model');
    expect(classifyOpenRouterFailure(Object.assign(new Error('late'), { name: 'TimeoutError' }))).toBe('next-model');
  });

  it('treats an unrecognised local error as a bug, not a model having a bad day', () => {
    expect(classifyOpenRouterFailure(new Error('boom'))).toBe('fatal');
  });
});

describe('describing OpenRouter failures', () => {
  it('names the upstream host and quotes what it said', () => {
    const line = describeOpenRouterFailure(upstreamRefusal);
    expect(line).toContain('400: Provider returned error');
    expect(line).toContain('upstream DeepSeek said');
    expect(line).toContain('Image in system message is unsupported');
  });

  it('says which setting blocked routing and where to change it', () => {
    const line = describeOpenRouterFailure(routingBlocked);
    expect(line).toContain('paid-model-training-violation-by-account');
    expect(line).toContain('https://openrouter.ai/settings/privacy');
  });

  it('falls back to the plain message for errors that never reached OpenRouter', () => {
    expect(describeOpenRouterFailure(new Error('fetch failed'))).toBe('no status: fetch failed');
  });
});
