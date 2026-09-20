// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isAbortError } from '@/lib/abort';
import {
  getKeyEpoch,
  peekQuery,
  queryFetch,
  subscribeQueries,
  type Query,
} from '@/lib/query-cache';
import { toError } from './internal/fetchCore';

export interface UseQueryResult<T> {
  /** Cached or freshly fetched value. Seeded synchronously from the cache, so a
   *  return visit paints immediately instead of flashing a spinner. */
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Force a network read for this key, bypassing the freshness window. */
  refetch: () => void;
}

/**
 * Read a {@link Query} through the shared cache.
 *
 * Differs from {@link useFetch} in the three ways that matter for the pages that
 * fan out on the same endpoints: identical keys in flight together share ONE
 * request, a fresh cache hit resolves without touching the network, and an
 * `invalidateQueries` anywhere in the app re-reads every mounted consumer. The
 * request is aborted on the wire when the last consumer of that key goes away.
 *
 * Pass `null` (or `enabled: false`) to stay idle — e.g. until an org id is
 * known. The descriptor may be rebuilt every render; its KEY is the dependency.
 *
 * @example
 * const { data, loading } = useQuery(orgId ? queries.orgMembers(orgId, { limit: 1 }) : null);
 */
export function useQuery<T>(
  query: Query<T> | null,
  options: { enabled?: boolean } = {},
): UseQueryResult<T> {
  const { enabled = true } = options;
  const active = enabled && query !== null;
  const key = query?.key ?? null;
  const staleMs = query?.staleMs;

  const [data, setData] = useState<T | null>(() => (key ? peekQuery<T>(key) ?? null : null));
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState<Error | null>(null);
  // Bumped by refetch(); `forceRef` makes only THAT run bypass the freshness
  // window — a later re-run (key change, invalidation) is an ordinary read.
  const [forceTick, setForceTick] = useState(0);
  const forceRef = useRef(false);
  const runRef = useRef(query?.run);
  runRef.current = query?.run;

  // Re-read when THIS key is invalidated (a mutation, an org switch). Scoped to
  // the key so an unrelated mutation doesn't churn every reader in the tree.
  const readEpoch = useCallback(() => getKeyEpoch(key), [key]);
  const epoch = useSyncExternalStore(subscribeQueries, readEpoch, readEpoch);

  useEffect(() => {
    if (!active || key === null) { setLoading(false); return; }
    // Repaint from cache on a key change before the request resolves.
    const cached = peekQuery<T>(key);
    if (cached !== undefined) setData(cached);

    const force = forceRef.current;
    forceRef.current = false;
    const controller = new AbortController();
    setLoading(true);
    queryFetch<T>(key, (signal) => runRef.current!(signal), { signal: controller.signal, force, staleMs })
      .then((value) => {
        setData(value);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        // A cancelled read is not a failure: the key changed, the component
        // unmounted, or a newer read superseded this one. Leave the last good
        // data, and let the run that replaced us own the loading flag.
        if (isAbortError(err) || controller.signal.aborted) return;
        setError(toError(err));
        setLoading(false);
      });
    return () => controller.abort();
    // `run` is read through a ref; the key is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `run` is read through a ref; the cache key is the real dependency
  }, [key, active, staleMs, forceTick, epoch]);

  const refetch = useCallback(() => {
    forceRef.current = true;
    setForceTick((t) => t + 1);
  }, []);

  return { data, loading, error, refetch };
}
