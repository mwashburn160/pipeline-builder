// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { incCounter, observe } from '@pipeline-builder/api-server';

/**
 * Who served a turn, as the metrics label it. `provider`/`model` are the RESOLVED
 * ones (after org-key selection and any failover) — never the request's
 * `undefined`/'default', which hid which provider was actually browning out. Both
 * are bounded by the catalog (plus the deployment's own OpenAI-compatible list), so
 * the cardinality is the catalog's size. `'unresolved'` marks a turn that failed
 * before any provider was chosen (AI off, nothing configured).
 */
export interface AiMetricLabels {
  provider?: string;
  model?: string;
}

/** Emit AI request metrics for one turn, so on-call can see provider brownouts and spend. */
export function recordAi(route: string, served: AiMetricLabels, outcome: 'success' | 'error' | 'aborted', startedAt: number): void {
  const provider = served.provider ?? 'unresolved';
  const model = served.model ?? 'unresolved';
  incCounter('ai_requests_total', { route, provider, model, outcome });
  if (outcome === 'success') {
    observe('ai_generation_duration_seconds', { route, provider, model }, (Date.now() - startedAt) / 1000);
  }
}

/**
 * Token accounting for one call. Labelled by the org's TIER and whose key paid,
 * not by org id: an org label would be a series per tenant, while tier × key source
 * answers the capacity question ("what is the free tier costing us on platform
 * keys?"). Per-ORG token totals live on the call's audit row instead, where they
 * can be queried per tenant without a Prometheus series each.
 */
export function recordAiTokens(
  route: string,
  served: AiMetricLabels & { keySource?: string; tier?: string },
  tokens: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): void {
  const base = { route, provider: served.provider ?? 'unresolved', key_source: served.keySource ?? 'unknown', tier: served.tier ?? 'unknown' };
  incCounter('ai_tokens_total', { ...base, kind: 'input' }, tokens.inputTokens);
  incCounter('ai_tokens_total', { ...base, kind: 'output' }, tokens.outputTokens);
  if (tokens.cachedInputTokens > 0) incCounter('ai_tokens_total', { ...base, kind: 'cached_input' }, tokens.cachedInputTokens);
}

/**
 * A reader's verdict on an answer.
 *
 * Low-cardinality on purpose: rating and whether the answer cited anything. The
 * WHICH — the docs involved — goes to the audit trail, where it can be queried
 * per organization; a Prometheus label per doc would multiply the series by the
 * size of the corpus.
 */
export function recordAskFeedback(rating: 'up' | 'down', grounded: boolean): void {
  incCounter('ask_feedback_total', { rating, grounded: String(grounded) });
}

/**
 * A help search that returned nothing.
 *
 * A COUNT only. The query text is what would make this directly actionable, and
 * it is user-entered text this service deliberately never records (see
 * `remote-audit-actions.ts`). The rate is still the signal worth having: a rise
 * means the corpus has drifted from what people are asking, and the audit trail
 * of rated answers says where to look.
 */
export function recordHelpSearchMiss(): void {
  incCounter('help_search_miss_total', {});
}
