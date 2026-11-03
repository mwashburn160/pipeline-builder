// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ObservabilityQueryResponse } from '@/types/observability';
import { useDashboardPanelQuery } from './useDashboardQueries';

/**
 * A metric panel's catalog query (instant or range), read from its dashboard's
 * batched refresh ({@link useDashboardPanelQuery}) — the range and the refresh
 * cadence are the dashboard's, not the panel's.
 *
 * The data shape is the raw envelope from the backend (samples for instant,
 * series for range). Panel components decide how to render it.
 */
export function useObservabilityQuery(key: string) {
  return useDashboardPanelQuery<ObservabilityQueryResponse>({ key });
}
