// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { api } from '@/lib/api';
import type { ObservabilityQueryResponse, RangeKey } from '@/types/observability';
import { useObservabilityResource } from './useObservabilityResource';

// Re-export for back-compat with consumers that imported RangeKey from this module.
export type { RangeKey };

/**
 * Fetches an observability metric query by catalog key. Re-polls every 30s
 * while the tab is visible; aborts the in-flight request on unmount or
 * range change so we don't write to a stale `setState`.
 *
 * The data shape is the raw envelope from the backend (samples for instant,
 * series for range). Panel components decide how to render it.
 */
export function useObservabilityQuery(key: string, range: RangeKey, vars?: { plugin?: string }) {
  // Stringify `vars` for the dep key — primitive keys keep React's
  // dependency comparator cheap and stable across re-renders.
  const varsKey = JSON.stringify(vars ?? {});
  const cacheKey = `${key}|${range}|${varsKey}`;

  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<ObservabilityQueryResponse | undefined> => {
      const res = await api.observabilityQuery(key, range, signal, vars);
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vars tracked via varsKey
    [key, range, varsKey],
  );

  return useObservabilityResource<ObservabilityQueryResponse>(fetcher, cacheKey);
}
