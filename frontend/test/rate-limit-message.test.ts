// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A rate-limited sign-in must say WHEN to try again. "Please try again later"
 * left a locked-out person retrying every few seconds — and on the sign-in
 * bucket every failed retry is counted, so retrying blind extended the wait.
 */

import { describe, it, expect } from '@jest/globals';
import { ApiError, QuotaExceededError } from '../src/lib/api/errors';
import { describeWait, rateLimitedMessage } from '../src/lib/rate-limit-message';

const limited = (retryAfter?: number, details?: Record<string, unknown>) => {
  const e = new ApiError('Too many authentication attempts. Please try again later.', 429, 'RATE_LIMIT_EXCEEDED', details);
  if (retryAfter !== undefined) e.retryAfter = retryAfter;
  return e;
};

describe('rateLimitedMessage', () => {
  it('replaces "later" with the wait from Retry-After', () => {
    expect(rateLimitedMessage(limited(690))).toBe('Too many authentication attempts. Try again in 12 minutes.');
  });

  it('falls back to the wait in the error body', () => {
    expect(rateLimitedMessage(limited(undefined, { retryAfterSeconds: 45 }))).toBe('Too many authentication attempts. Try again in 45 seconds.');
  });

  it('keeps "later" when the server gave no wait', () => {
    expect(rateLimitedMessage(limited())).toBe('Too many authentication attempts. Please try again later.');
  });

  it('leaves every other error to the caller', () => {
    expect(rateLimitedMessage(new ApiError('Invalid credentials', 401, 'INVALID_CREDENTIALS'))).toBeNull();
    expect(rateLimitedMessage(new Error('network'))).toBeNull();
    expect(rateLimitedMessage('nope')).toBeNull();
  });

  it('leaves a quota 429 to its own UI', () => {
    const quota = Object.create(QuotaExceededError.prototype) as QuotaExceededError;
    Object.assign(quota, { message: 'Quota exceeded', statusCode: 429, code: 'QUOTA_EXCEEDED' });
    expect(rateLimitedMessage(quota)).toBeNull();
    expect(rateLimitedMessage(new ApiError('Quota exceeded', 429, 'QUOTA_EXCEEDED'))).toBeNull();
  });
});

describe('describeWait', () => {
  it('rounds up, so the person never comes back early into a second refusal', () => {
    expect(describeWait(1)).toBe('a second');
    expect(describeWait(59)).toBe('59 seconds');
    expect(describeWait(60)).toBe('a minute');
    expect(describeWait(61)).toBe('2 minutes');
    expect(describeWait(900)).toBe('15 minutes');
  });
});
