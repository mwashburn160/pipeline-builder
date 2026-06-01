// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { api } from '@/lib/api';
import type { ObservabilityLogsResponse, ObservabilityLogsParams, RangeKey } from '@/types/observability';
import { useObservabilityResource } from './useObservabilityResource';

// Re-export for back-compat with consumers that imported RangeKey from this module.
export type { RangeKey };

/**
 * Mirror of useObservabilityQuery for Loki-backed catalog queries.
 * Templated params (event/digest/actor) are passed through verbatim — the
 * backend sanitizes them server-side via substituteVars.
 */
export function useObservabilityLogs(
  key: string,
  range: RangeKey,
  opts: Omit<ObservabilityLogsParams, 'range'> = {},
) {
  // Stringify opts so the effect re-runs when any optional param changes
  // without re-running on every render (which would happen with an object dep).
  const optsKey = JSON.stringify(opts);
  const cacheKey = `${key}|${range}|${optsKey}`;

  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<ObservabilityLogsResponse | undefined> => {
      const res = await api.observabilityLogs(key, range, opts, signal);
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opts tracked via optsKey
    [key, range, optsKey],
  );

  return useObservabilityResource<ObservabilityLogsResponse>(fetcher, cacheKey);
}
