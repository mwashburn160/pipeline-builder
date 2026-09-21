// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { api } from '@/lib/api';
import type { LogQueryParams, LogSearchResponse, LogVolumeResponse } from '@/types/logs';
import { useObservabilityResource } from './useObservabilityResource';

/** Stable cache key for a query: the window plus every filter that changes results. */
function cacheKey(prefix: string, params: LogQueryParams): string {
  const win = params.window.kind === 'preset'
    ? params.window.key
    // Absolute windows key on their exact bounds; a "preset" re-render recomputes
    // `Date.now()` each time and must NOT thrash the cache, which is why presets
    // are kept symbolic rather than resolved to timestamps client-side.
    : `${params.window.fromMs}-${params.window.toMs}`;
  return [prefix, win, params.q ?? '', params.limit ?? '', (params.orgs ?? []).join(',')].join('|');
}

/** Log entries for the current query. */
export function useLogSearch(params: LogQueryParams, enabled = true) {
  const key = cacheKey('search', params);
  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<LogSearchResponse | undefined> => {
      if (!enabled) return undefined;
      const res = await api.logSearch(params, signal);
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params tracked via `key`
    [key, enabled],
  );
  // `enabled` is part of the resource key. The resource re-binds (and fetches)
  // only when its key changes, and `enabled` used to live only inside the
  // fetcher — so on a hard load, where auth is still initialising, the first
  // fetch returned nothing and flipping `enabled` on did not fetch again: the
  // Logs page read "0 entries" with an empty histogram for up to 30s, until the
  // next interval tick.
  return useObservabilityResource<LogSearchResponse>(fetcher, `${key}|${enabled ? 'on' : 'off'}`);
}

/** Per-level volume for the histogram above the list. */
export function useLogVolume(params: LogQueryParams, enabled = true) {
  const key = cacheKey('volume', params);
  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<LogVolumeResponse | undefined> => {
      if (!enabled) return undefined;
      const res = await api.logVolume(params, signal);
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params tracked via `key`
    [key, enabled],
  );
  // `enabled` in the key for the same reason as useLogSearch.
  return useObservabilityResource<LogVolumeResponse>(fetcher, `${key}|${enabled ? 'on' : 'off'}`);
}
