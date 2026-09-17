// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { runCancellableFetch } from './internal/fetchCore';

/**
 * Generic "fetch-once-or-on-deps-change" hook.
 *
 * Replaces the hand-rolled `setLoading / cancelled flag / setError / finally
 * setLoading(false)` pattern repeated across 7+ pages and 4+ component
 * directories. Cancels in-flight state writes when the consumer unmounts
 * or the deps change.
 *
 * It stores the fetcher in a ref so callers DON'T need to memoize it, returns
 * `error: Error | null` + `refetch()`, and drops stale state writes on
 * unmount/deps-change (the in-flight request itself is not aborted).
 *
 * @example
 * const { data, loading, error, refetch } = useFetch(
 *   () => api.listAlertDestinations(),
 *   [orgId],
 * );
 */
export function useFetch<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    return runCancellableFetch(() => fetcherRef.current(), {
      onStart: () => {
        setLoading(true);
        setError(null);
      },
      onSuccess: setData,
      onError: setError,
      onSettled: () => setLoading(false),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
