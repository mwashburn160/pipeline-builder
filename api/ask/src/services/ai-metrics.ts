// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { incCounter, observe } from '@pipeline-builder/api-server';

/**
 * Emit AI request metrics for one turn, so on-call can see provider brownouts
 * and spend. `provider` is the requested one or 'default' when the server picks;
 * kept low-cardinality (no per-model label).
 */
export function recordAi(route: string, provider: string | undefined, outcome: 'success' | 'error' | 'aborted', startedAt: number): void {
  const providerLabel = provider ?? 'default';
  incCounter('ai_requests_total', { route, provider: providerLabel, outcome });
  if (outcome === 'success') {
    observe('ai_generation_duration_seconds', { route, provider: providerLabel }, (Date.now() - startedAt) / 1000);
  }
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
