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
 * `error: Error | null` + `refetch()`, and cancels the in-flight request on
 * unmount/deps-change. The fetcher receives an `AbortSignal`; forward it to the
 * API client to stop the request on the wire (callers that ignore it simply
 * keep the old "drop the late answer" behaviour).
 *
 * @example
 * const { data, loading, error, refetch } = useFetch(
 *   (signal) => api.listAlertDestinations({ signal }),
 *   [orgId],
 * );
 */
export function useFetch<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
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
    return runCancellableFetch((signal) => fetcherRef.current(signal), {
      onStart: () => {
        setLoading(true);
        setError(null);
      },
      onSuccess: setData,
      onError: setError,
      onSettled: () => setLoading(false),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's `deps` are spread in, so the list size is not statically known
  }, [...deps, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
