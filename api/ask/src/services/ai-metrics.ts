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
