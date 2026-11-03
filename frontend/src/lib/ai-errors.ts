// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How an AI failure reads to the user, wherever AI is offered (Ask, pipeline and
 * plugin generation, report summaries).
 *
 * The backend already answers with a sentence of its own (`handleAIError` never
 * forwards a provider's raw error body), so this only adds the two things a
 * generic `formatError` cannot: a busy provider's wait time ("retry in N s",
 * from its `Retry-After`), and the org's AI switch being off. A quota refusal is
 * not handled here — `QuotaExceededError` raises the global notice already.
 */

import type { StreamEvent } from '@/lib/api/core';
import { ApiError, QuotaExceededError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';

/** The code every AI entry point answers when an org's administrators switched AI off. */
export const AI_DISABLED_CODE = 'AI_DISABLED';

/** Shown in place of an AI control while the org's AI switch is off. */
export const AI_DISABLED_MESSAGE = 'AI features are turned off for this organization. An organization administrator can turn them back on in Settings → AI providers.';

/** True for an error that says the org switched AI off. */
export function isAIDisabledError(err: unknown): boolean {
  return err instanceof ApiError && err.code === AI_DISABLED_CODE;
}

/**
 * The error an SSE `error` event describes, as an {@link ApiError} — so a failure
 * that arrives mid-stream reads exactly like one that arrived as an HTTP status.
 */
export function streamEventError(event: StreamEvent, fallback = 'The AI request failed'): ApiError {
  const error = new ApiError(event.message || fallback, event.status ?? 500, event.code);
  if (typeof event.retryAfterSeconds === 'number') error.retryAfter = event.retryAfterSeconds;
  return error;
}

/**
 * The sentence to show for an AI failure: the disabled-org message; for a 429/503
 * that is NOT a quota refusal (a busy provider, or the per-org burst limiter) the
 * server's sentence with the wait it asked for ("… Retry in 12 s."); else the
 * server's own message (or `fallback`).
 */
export function formatAIError(err: unknown, fallback: string): string {
  if (isAIDisabledError(err)) return AI_DISABLED_MESSAGE;
  if (err instanceof ApiError && !(err instanceof QuotaExceededError) && (err.statusCode === 429 || err.statusCode === 503)) {
    const base = (err.message || 'The AI provider is busy.').replace(/\s*Try again shortly\.?$/, '');
    const punctuated = /[.!?]$/.test(base) ? base : `${base}.`;
    return typeof err.retryAfter === 'number' && err.retryAfter > 0
      ? `${punctuated} Retry in ${err.retryAfter} s.`
      : `${punctuated} Try again in a moment.`;
  }
  return formatError(err, fallback);
}
