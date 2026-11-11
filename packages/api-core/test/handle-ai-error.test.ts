// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `handleAIError` — how an AI generation failure reaches the user.
 *
 * The configuration branch used to replace the thrown message with a fixed
 * string: "AI generation is not configured for the requested provider". That was
 * both unhelpful and, in the commonest case, wrong — when the Ask panel sends no
 * provider at all, nothing was "requested", so the text sent operators looking
 * for a provider bug instead of at the missing configuration the service had
 * already named precisely.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { Response } from 'express';
import { AIConfigurationError, AIDisabledError } from '../src/errors/app-errors.js';
import { handleAIError } from '../src/helpers/sse-helpers.js';

function mockRes(headersSent = false) {
  const r: Record<string, unknown> = { headersSent, statusCode: 0, body: undefined, written: [] as string[] };
  r.status = jest.fn((c: number) => { r.statusCode = c; return r; });
  r.json = jest.fn((b: unknown) => { r.body = b; return r; });
  r.write = jest.fn((chunk: string) => { (r.written as string[]).push(chunk); return true; });
  r.end = jest.fn(() => r);
  r.headers = {} as Record<string, string>;
  r.setHeader = jest.fn((k: string, v: string) => { (r.headers as Record<string, string>)[k] = v; return r; });
  return r as unknown as Response & { statusCode: number; body: { message?: string; code?: string; details?: unknown }; written: string[]; headers: Record<string, string> };
}

describe('handleAIError — configuration failures', () => {
  it('surfaces WHICH configuration is missing, not a generic sentence', () => {
    const res = mockRes();
    handleAIError(
      res,
      'AI is not configured: no provider API key is set and OPENAI_COMPATIBLE_BASE_URL is unset.',
      'The assistant failed to respond',
    );

    // The env var names are the actionable part — and they are KEYS, never values.
    expect(res.body.message).toContain('OPENAI_COMPATIBLE_BASE_URL');
    expect(res.body.message).not.toContain('for the requested provider');
  });

  it('keeps a named provider\'s own message intact', () => {
    const res = mockRes();
    handleAIError(res, 'AI provider "anthropic" is not configured. Set the corresponding API key environment variable.', 'fallback');
    expect(res.body.message).toContain('anthropic');
    expect(res.body.message).toContain('API key environment variable');
  });

  it('still uses the caller fallback for an unrelated failure', () => {
    const res = mockRes();
    handleAIError(res, 'socket hang up', 'The assistant failed to respond');
    expect(res.body.message).toBe('The assistant failed to respond');
  });

  it('maps an unavailable model to a 400 rather than a 500', () => {
    const res = mockRes();
    handleAIError(res, 'model "x" is not available for provider "y"', 'fallback');
    expect(res.statusCode).toBe(400);
  });

  it('writes an SSE error event once the stream has started', () => {
    // Mid-stream there is no status code left to set — the turn has begun.
    const res = mockRes(true);
    handleAIError(res, 'AI is not configured: …', 'fallback');
    expect(res.written.join('')).toContain('"type":"error"');
    expect(res.end).toHaveBeenCalled();
  });
});

/** An ai-sdk `APICallError`, as far as the classifier reads it (duck-typed). */
function providerError(statusCode: number, body: string, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`Provider said: ${body}`), { statusCode, responseHeaders: headers, responseBody: body });
}

describe('handleAIError — provider failures map on STATUS, with a sanitized message', () => {
  const LEAK = 'org_id=acct-123456 request_id=req_abc prompt="the user secret text"';

  it('429 → 429 with the provider\'s Retry-After, never the provider text', () => {
    const res = mockRes();
    handleAIError(res, providerError(429, LEAK, { 'retry-after': '17' }), 'fallback');
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('17');
    expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(JSON.stringify(res.body)).not.toContain('acct-123456');
    expect(res.body.details).toBeUndefined();
  });

  it('529 (overloaded) and 5xx → 503', () => {
    for (const status of [529, 500, 502, 503]) {
      const res = mockRes();
      handleAIError(res, providerError(status, LEAK), 'fallback');
      expect(res.statusCode).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('req_abc');
    }
  });

  it('a provider 401 is NOT mistaken for a configuration message, though its text says "API key"', () => {
    const res = mockRes();
    handleAIError(res, providerError(401, 'invalid x-api-key: sk-ant-REDACTME'), 'fallback');
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('sk-ant');
  });

  it('a timeout signal → 504', () => {
    const res = mockRes();
    handleAIError(res, Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'fallback');
    expect(res.statusCode).toBe(504);
  });

  it('the SSE error frame carries the sanitized message, never the raw provider text', () => {
    const res = mockRes(true);
    handleAIError(res, providerError(529, LEAK, { 'retry-after': '3' }), 'fallback');
    const frame = res.written.join('');
    expect(frame).toContain('"type":"error"');
    expect(frame).toContain('"status":503');
    expect(frame).toContain('"retryAfterSeconds":3');
    expect(frame).not.toContain('acct-123456');
    expect(res.end).toHaveBeenCalled();
  });

  it('a provider 4xx names the STATUS but never the body (a tools-rejection must be diagnosable)', () => {
    // A self-hosted OpenAI-compatible server that does not implement function
    // calling answers 400 to the Ask agent, which always sends `tools`. The
    // status is the only safe part of that refusal: the body carries org ids,
    // request ids and the prompt.
    const res = mockRes();
    handleAIError(res, providerError(400, LEAK), 'The assistant failed to respond');
    expect(res.statusCode).toBe(502);
    expect(res.body.message).toContain('HTTP 400');
    expect(res.body.message).toContain('The assistant failed to respond');
    expect(res.body.message).not.toContain('acct-123456');
    expect(res.body.message).not.toContain('the user secret text');
  });

  it('an unrelated Error gets the fallback with NO details (the raw message stays in the log)', () => {
    const res = mockRes();
    handleAIError(res, new Error('stack-ish internal text'), 'The assistant failed to respond');
    expect(res.body.message).toBe('The assistant failed to respond');
    expect(res.body.details).toBeUndefined();
  });

  it('AppErrors keep their own status and message (AI switched off, org key unloadable)', () => {
    const off = mockRes();
    handleAIError(off, new AIDisabledError(), 'fallback');
    expect(off.statusCode).toBe(403);
    expect(off.body.code).toBe('AI_DISABLED');
    const key = mockRes();
    handleAIError(key, new AIConfigurationError('The organization\'s anthropic API key could not be loaded'), 'fallback');
    expect(key.statusCode).toBe(503);
    expect(key.body.message).toContain('could not be loaded');
  });
});
