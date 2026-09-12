// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry policy shared by every service-to-service HTTP call.
 *
 * Untested until now, which matters more than the line count suggests: these
 * are the decisions that separate "ride out a transient blip" from "hammer a
 * struggling dependency". The properties worth pinning are the boundaries —
 * what is retryable, when the budget is exhausted, and that a server-supplied
 * `Retry-After` is both honoured and capped.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import {
  parseRetryAfter,
  addJitter,
  calculateBackoff,
  isTransientStatusCode,
  isRateLimited,
  getRetryDecision,
  getErrorRetryDecision,
  type RetryConfig,
} from '../src/services/retry-strategy.js';

const config: RetryConfig = { maxRetries: 2, retryDelayMs: 200, maxRateLimitRetries: 4 };

afterEach(() => {
  jest.restoreAllMocks();
});

describe('parseRetryAfter', () => {
  it('reads numeric seconds as milliseconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP-date as a delay from now', () => {
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfter(inTenSeconds)!;
    // Second-resolution header, so allow a small window.
    expect(parsed).toBeGreaterThan(8_000);
    expect(parsed).toBeLessThanOrEqual(11_000);
  });

  it('takes the first value when the header repeats', () => {
    expect(parseRetryAfter(['7', '99'])).toBe(7000);
  });

  it('CAPS an absurd value so a hostile or buggy upstream cannot park a worker', () => {
    // Without the cap, `Retry-After: 999999999` would pin a caller for years.
    const huge = parseRetryAfter('999999999')!;
    expect(huge).toBeLessThanOrEqual(60 * 60 * 1000);
    const farFuture = parseRetryAfter(new Date(Date.now() + 10 ** 10).toUTCString())!;
    expect(farFuture).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('returns undefined for missing, empty, or unparseable values', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter([])).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
  });

  it('ignores a date already in the past rather than retrying with a negative delay', () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBeUndefined();
  });
});

describe('calculateBackoff', () => {
  it('doubles per attempt', () => {
    expect(calculateBackoff(200, 0)).toBe(200);
    expect(calculateBackoff(200, 1)).toBe(400);
    expect(calculateBackoff(200, 2)).toBe(800);
  });
});

describe('addJitter', () => {
  it('stays within +/-25% of the delay', () => {
    for (let i = 0; i < 200; i += 1) {
      const jittered = addJitter(1000);
      expect(jittered).toBeGreaterThanOrEqual(750);
      expect(jittered).toBeLessThanOrEqual(1250);
    }
  });

  it('never returns a negative delay', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // maximum negative jitter
    expect(addJitter(0)).toBe(0);
    expect(addJitter(10)).toBeGreaterThanOrEqual(0);
  });

  it('spreads callers out — the whole point is avoiding a thundering herd', () => {
    const seen = new Set(Array.from({ length: 50 }, () => addJitter(1000)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('status classification', () => {
  it('treats 502/503/504 as transient', () => {
    for (const code of [502, 503, 504]) expect(isTransientStatusCode(code)).toBe(true);
  });

  it('does NOT treat 500 as transient — a genuine bug should not be hammered', () => {
    expect(isTransientStatusCode(500)).toBe(false);
  });

  it('does not retry client errors', () => {
    for (const code of [400, 401, 403, 404, 409, 422]) {
      expect(isTransientStatusCode(code)).toBe(false);
      expect(isRateLimited(code)).toBe(false);
    }
  });

  it('recognizes 429 as rate limiting, distinct from transient', () => {
    expect(isRateLimited(429)).toBe(true);
    expect(isTransientStatusCode(429)).toBe(false);
  });
});

describe('getRetryDecision', () => {
  it('retries a transient 503 with exponential backoff', () => {
    const d = getRetryDecision(503, {}, 0, config);
    expect(d.shouldRetry).toBe(true);
    expect(d.reason).toMatch(/503/);
    expect(d.delayMs).toBeGreaterThan(0);
  });

  it('stops retrying transient errors once the budget is spent', () => {
    expect(getRetryDecision(503, {}, config.maxRetries, config).shouldRetry).toBe(false);
    expect(getRetryDecision(503, {}, config.maxRetries, config).reason).toBe('Not retryable');
  });

  it('never retries a 4xx or a 500', () => {
    for (const code of [400, 401, 403, 404, 409, 500]) {
      expect(getRetryDecision(code, {}, 0, config).shouldRetry).toBe(false);
    }
  });

  it('honours Retry-After on a 429 instead of its own backoff', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    const d = getRetryDecision(429, { 'retry-after': '3' }, 0, config);
    expect(d.shouldRetry).toBe(true);
    expect(d.delayMs).toBe(3000);
  });

  it('falls back to a LONGER backoff than a 5xx when 429 sends no Retry-After', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    const rateLimited = getRetryDecision(429, {}, 0, config).delayMs;
    const transient = getRetryDecision(503, {}, 0, config).delayMs;
    // Being told to slow down warrants backing off harder than a blip.
    expect(rateLimited).toBeGreaterThan(transient);
  });

  it('gives 429 a SEPARATE, larger budget than transient errors', () => {
    // Past the transient budget but inside the rate-limit budget.
    const attempt = config.maxRetries + 1;
    expect(getRetryDecision(503, {}, attempt, config).shouldRetry).toBe(false);
    expect(getRetryDecision(429, {}, attempt, config).shouldRetry).toBe(true);
  });

  it('stops retrying 429 once its own budget is spent', () => {
    expect(getRetryDecision(429, {}, config.maxRateLimitRetries, config).shouldRetry).toBe(false);
  });
});

describe('getErrorRetryDecision', () => {
  it('retries a connection/timeout error within budget', () => {
    const d = getErrorRetryDecision(0, config);
    expect(d.shouldRetry).toBe(true);
    expect(d.reason).toMatch(/Connection or timeout/);
  });

  it('backs off exponentially across attempts', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    expect(getErrorRetryDecision(1, config).delayMs)
      .toBeGreaterThan(getErrorRetryDecision(0, config).delayMs);
  });

  it('gives up once max retries are exhausted', () => {
    const d = getErrorRetryDecision(config.maxRetries, config);
    expect(d.shouldRetry).toBe(false);
    expect(d.delayMs).toBe(0);
    expect(d.reason).toBe('Max retries exceeded');
  });
});
