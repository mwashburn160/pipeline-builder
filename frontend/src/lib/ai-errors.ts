// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How an AI failure reads to the user, wherever AI is offered (Ask, pipeline and
 * plugin generation, report summaries).
 *
 * The backend already answers with a sentence of its own (`handleAIError` never
 * forwards a provider's raw error body), so this only adds the two things a
 * generic `formatError` cannot: a busy provider's wait time ("retry in N s",
 * from its `Retry-After`), the org's AI switch being off, and a member's share of
 * the org's AI calls being used up. An org quota refusal is
 * not handled here — `QuotaExceededError` raises the global notice already.
 */

import type { StreamEvent } from '@/lib/api/core';
import { ApiError, QuotaExceededError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';

/** The code every AI entry point answers when an org's administrators switched AI off. */
export const AI_DISABLED_CODE = 'AI_DISABLED';

/** Shown in place of an AI control while the org's AI switch is off. */
export const AI_DISABLED_MESSAGE = 'AI features are turned off for this organization. An organization administrator can turn them back on in Settings → AI providers.';

/**
 * The code a 429 carries when the ORG still has AI calls but this MEMBER has
 * used their share of them (the org's per-member AI share setting). It is not
 * `QUOTA_EXCEEDED` — the org's quota is not exhausted, so the global "quota
 * reached · upgrade" notice would be wrong — and not a busy provider, so
 * "try again in a moment" would be wrong too.
 */
export const AI_MEMBER_SHARE_CODE = 'AI_MEMBER_SHARE_EXCEEDED';

/** The code a 429 carries when the org's optional per-period AI TOKEN budget is spent. */
export const AI_TOKEN_BUDGET_CODE = 'AI_TOKEN_BUDGET_EXCEEDED';

/** True for a refusal because this member used up their share of the org's AI calls. */
export function isAIMemberShareError(err: unknown): boolean {
  return err instanceof ApiError && err.code === AI_MEMBER_SHARE_CODE;
}

/**
 * The sentence for a used-up member share. The quota service's details are
 * `{ quota: { limit, used, resetAt }, resetAt }` — `limit` is the MEMBER's
 * share, not the org's — and its own message prints the reset as a raw ISO
 * string, so the sentence is rebuilt here in the reader's locale.
 */
function memberShareMessage(err: ApiError): string {
  const d = err.details ?? {};
  const q = (d.quota && typeof d.quota === 'object' ? d.quota : {}) as Record<string, unknown>;
  const used = typeof q.used === 'number' ? q.used : undefined;
  const limit = typeof q.limit === 'number' ? q.limit : undefined;
  const resetAt = typeof d.resetAt === 'string' ? d.resetAt : typeof q.resetAt === 'string' ? q.resetAt : undefined;
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  const counts = used !== undefined && limit !== undefined ? ` (${used.toLocaleString()} of ${limit.toLocaleString()})` : '';
  const reset = Number.isFinite(resetMs) ? ` It resets ${new Date(resetMs).toLocaleString()}.` : '';
  return `You've used your share of your organization's AI calls for this period${counts}.${reset} `
    + 'A billing contact can change the per-member share on the Quotas page, or you can use your own provider key.';
}

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
 * The sentence to show for an AI failure: the disabled-org message; a member's
 * used-up AI share or the org's spent token budget, each with what to do; for a 429/503
 * that is NOT a quota refusal (a busy provider, or the per-org burst limiter) the
 * server's sentence with the wait it asked for ("… Retry in 12 s."); else the
 * server's own message (or `fallback`).
 */
export function formatAIError(err: unknown, fallback: string): string {
  if (isAIDisabledError(err)) return AI_DISABLED_MESSAGE;
  if (isAIMemberShareError(err)) return memberShareMessage(err as ApiError);
  // The server's sentence already says what was spent and who can raise it;
  // it must just not fall into the busy-provider branch below ("try again in a
  // moment" — it will not work again until the period resets).
  if (err instanceof ApiError && err.code === AI_TOKEN_BUDGET_CODE) {
    return err.message || 'Your organization has used its AI token budget for this period.';
  }
  if (err instanceof ApiError && !(err instanceof QuotaExceededError) && (err.statusCode === 429 || err.statusCode === 503)) {
    const base = (err.message || 'The AI provider is busy.').replace(/\s*Try again shortly\.?$/, '');
    const punctuated = /[.!?]$/.test(base) ? base : `${base}.`;
    return typeof err.retryAfter === 'number' && err.retryAfter > 0
      ? `${punctuated} Retry in ${err.retryAfter} s.`
      : `${punctuated} Try again in a moment.`;
  }
  return formatError(err, fallback);
}
