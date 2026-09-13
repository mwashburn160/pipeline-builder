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
import { handleAIError } from '../src/helpers/sse-helpers.js';

function mockRes(headersSent = false) {
  const r: Record<string, unknown> = { headersSent, statusCode: 0, body: undefined, written: [] as string[] };
  r.status = jest.fn((c: number) => { r.statusCode = c; return r; });
  r.json = jest.fn((b: unknown) => { r.body = b; return r; });
  r.write = jest.fn((chunk: string) => { (r.written as string[]).push(chunk); return true; });
  r.end = jest.fn(() => r);
  return r as unknown as Response & { statusCode: number; body: { message?: string }; written: string[] };
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
