// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ObservabilityLogsResponse, ObservabilityLogsParams } from '@/types/observability';
import { useDashboardPanelQuery } from './useDashboardQueries';

/**
 * Mirror of useObservabilityQuery for audit-trail (`audit-store`) catalog
 * queries. Filter params are passed through verbatim — the backend keeps only
 * the ones the catalog entry allows.
 */
export function useObservabilityLogs(key: string, opts: Omit<ObservabilityLogsParams, 'range'> = {}) {
  const { limit, event, actor, requestId } = opts;
  return useDashboardPanelQuery<ObservabilityLogsResponse>({ key, audit: true, limit, event, actor, requestId });
}
