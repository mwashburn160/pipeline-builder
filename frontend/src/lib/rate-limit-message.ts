// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ApiError, QuotaExceededError } from '@/lib/api/errors';

/**
 * How long a wait reads to a person: "a minute", "12 minutes", "45 seconds".
 * Rounded UP — saying "try again in 11 minutes" when the bucket drains in
 * 11m40s sends the person back to a second refusal.
 */
export function describeWait(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.ceil(seconds));
    return s === 1 ? 'a second' : `${s} seconds`;
  }
  const m = Math.ceil(seconds / 60);
  return m === 1 ? 'a minute' : `${m} minutes`;
}

/** Seconds the server said to wait: `Retry-After`, else the body's `details.retryAfterSeconds`. */
function waitSeconds(err: ApiError): number | undefined {
  if (typeof err.retryAfter === 'number' && err.retryAfter > 0) return err.retryAfter;
  const fromBody = err.details?.retryAfterSeconds;
  return typeof fromBody === 'number' && fromBody > 0 ? fromBody : undefined;
}

/**
 * The message for a rate-limited request (429 `RATE_LIMIT_EXCEEDED`), with WHEN
 * to try again in place of the server's "Please try again later." — or `null`
 * for any other error, so the caller falls back to its own formatting.
 *
 * Sign-in is where this matters: "later" leaves a locked-out person retrying
 * every few seconds, and on the sign-in bucket every failed retry is counted.
 * A quota 429 (`QUOTA_EXCEEDED`) is a different thing with its own UI.
 */
export function rateLimitedMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err instanceof QuotaExceededError) return null;
  if (err.statusCode !== 429 || (err.code !== undefined && err.code !== 'RATE_LIMIT_EXCEEDED')) return null;
  const base = (err.message || 'Too many requests.').replace(/\s*Please try again later\.?\s*$/i, '').trim();
  const wait = waitSeconds(err);
  const sentence = /[.!?]$/.test(base) ? base : `${base}.`;
  return wait === undefined ? `${sentence} Please try again later.` : `${sentence} Try again in ${describeWait(wait)}.`;
}
