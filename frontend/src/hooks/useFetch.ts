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
 * API client to stop the request on the wire (callers that ignore it only drop
 * the late answer).
 *
 * @example
 * const { data, loading, error, refetch } = useFetch(
 *   (signal) => api.listAlertDestinations({ signal }),
 *   [orgId],
 * );
 */
export interface UseFetchOptions<T> {
  /** Called with a loaded value in the same render as `data` — e.g. to seed a
   *  form from it without an intermediate unseeded render. */
  onSuccess?: (value: T) => void;
  /** Called with a failed load's error (e.g. to toast it). Prior `data` is kept. */
  onError?: (err: Error) => void;
  /**
   * Drop `data` when a read fails, instead of keeping the last good value.
   *
   * For a TYPEAHEAD, where the old answer belongs to a query the person has
   * already moved on from: keeping it leaves stale options sitting next to the
   * error that says the search failed, and picking one acts on a result the
   * search never returned.
   */
  clearDataOnError?: boolean;
  /**
   * When false, no read fires and `loading` is false — for a fetcher that could
   * only answer "nothing" (a permission this viewer lacks, an id not chosen
   * yet). The alternative, a fetcher that returns `null`, still schedules a full
   * async round trip whose ONLY effect is setting `loading` back to false.
   */
  enabled?: boolean;
}

export function useFetch<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown>,
  options: UseFetchOptions<T> = {},
): {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Re-run the fetcher; resolves once that run has settled — `true` when it succeeded. */
  refetch: () => Promise<boolean>;
} {
  const { enabled = true, clearDataOnError = false } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const onSuccessRef = useRef(options.onSuccess);
  onSuccessRef.current = options.onSuccess;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  // `refetch()` callers waiting for the run they triggered (or a later one) to settle.
  const waitersRef = useRef<Array<(ok: boolean) => void>>([]);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let ok = false;
    return runCancellableFetch((signal) => fetcherRef.current(signal), {
      onStart: () => {
        setLoading(true);
        setError(null);
      },
      onSuccess: (value) => {
        ok = true;
        setData(value);
        onSuccessRef.current?.(value);
      },
      onError: (err) => {
        setError(err);
        if (clearDataOnError) setData(null);
        onErrorRef.current?.(err);
      },
      onSettled: () => {
        setLoading(false);
        const waiters = waitersRef.current;
        waitersRef.current = [];
        for (const resolve of waiters) resolve(ok);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's `deps` are spread in, so the list size is not statically known
  }, [...deps, tick, enabled, clearDataOnError]);

  const refetch = useCallback(() => new Promise<boolean>((resolve) => {
    waitersRef.current.push(resolve);
    setTick((t) => t + 1);
  }), []);
  return { data, loading, error, refetch };
}
