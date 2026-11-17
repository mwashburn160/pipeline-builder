// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How a refused response becomes an error: the wait a 429/503 asks for, the
 * message with any markup stripped (streams included), and the registry
 * domain's 409 narrowing — which must leave every OTHER refusal's class alone.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { ApiCore } from '../src/lib/api/core';
import { ApiError, ConflictError, StepUpRequiredError, toRegistryError } from '../src/lib/api/errors';
import { registryApi } from '../src/lib/api/domains/registry';
import { parseRetryAfterSeconds } from '../src/lib/api/util';

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return { status, ok: status < 400, body: null, headers: new Headers(headers), json: async () => body } as unknown as Response;
}

const realFetch = global.fetch;
function serve(response: Response): void {
  global.fetch = jest.fn<AnyFn>(async () => response) as unknown as typeof fetch;
}
afterEach(() => { global.fetch = realFetch; });

describe('parseRetryAfterSeconds', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfterSeconds('120')).toBe(120);
    expect(parseRetryAfterSeconds(' 1.2 ')).toBe(2);
  });

  it('reads an HTTP date as the seconds until it', () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const seconds = parseRetryAfterSeconds(at)!;
    expect(seconds).toBeGreaterThanOrEqual(88);
    expect(seconds).toBeLessThanOrEqual(90);
  });

  it('treats a missing, zero, past or garbled value as no wait', () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds('0')).toBeUndefined();
    expect(parseRetryAfterSeconds(new Date(Date.now() - 60_000).toUTCString())).toBeUndefined();
    expect(parseRetryAfterSeconds('soon')).toBeUndefined();
  });
});

describe('ApiCore error mapping', () => {
  it('carries an HTTP-date Retry-After on a 429 as seconds', async () => {
    const at = new Date(Date.now() + 60_000).toUTCString();
    serve(res(429, { message: 'Slow down', code: 'RATE_LIMIT_EXCEEDED' }, { 'Retry-After': at }));
    const err = await new ApiCore().request('/api/things').catch((e: unknown) => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.retryAfter).toBeGreaterThan(0);
  });

  it('falls back to the caller message when the server message is only markup', async () => {
    serve(res(500, { message: '<br/>' }));
    const err = await new ApiCore().request('/api/things', { errorMessage: 'Could not load things' }).catch((e: unknown) => e) as ApiError;
    expect(err.message).toBe('Could not load things');
  });

  it('strips markup from a refused stream\'s message, like a refused request', async () => {
    serve(res(503, { message: '<b>Provider</b> busy', code: 'AI_BUSY' }, { 'Retry-After': '7' }));
    const stream = new ApiCore().streamRequest('/api/ai/generate', {});
    const err = await stream.next().catch((e: unknown) => e) as ApiError;
    expect(err.message).toBe('Provider busy');
    expect(err.retryAfter).toBe(7);
  });
});

describe('registry error narrowing', () => {
  it('turns a 409 into a ConflictError with its reason', () => {
    const narrowed = toRegistryError(new ApiError('exists', 409, 'CONFLICT', { reason: 'target-exists' }));
    expect(narrowed).toBeInstanceOf(ConflictError);
    expect((narrowed as ConflictError).reason).toBe('target-exists');
  });

  it('returns any other error untouched — a step-up refusal keeps its class and replay', async () => {
    const refusal = new StepUpRequiredError('Confirm', 'STEP_UP_REQUIRED');
    refusal.attachResume(Promise.resolve({ ok: true }));
    const core = { request: jest.fn<AnyFn>(async () => { throw refusal; }) } as unknown as ApiCore;

    const err = await registryApi(core).copyImage({ source: 'a:1', target: 'b:1' }).catch((e: unknown) => e);
    expect(err).toBe(refusal);
    expect((err as StepUpRequiredError).resume).toBeDefined();
  });

  it('keeps a rate-limited blob read\'s Retry-After', async () => {
    const limited = new ApiError('Too many', 429, 'RATE_LIMIT_EXCEEDED');
    limited.retryAfter = 30;
    const core = { request: jest.fn<AnyFn>(async () => { throw limited; }) } as unknown as ApiCore;
    const err = await registryApi(core).getImageBlob('repo', 'sha256:abc').catch((e: unknown) => e);
    expect(err).toBe(limited);
  });
});
