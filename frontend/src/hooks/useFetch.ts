// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { runCancellableFetch } from './internal/fetchCore';
import { useTagEpoch } from './internal/useTagEpoch';

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
  /** Called with a failed load's error (e.g. to toast it). Prior `data` for the same deps is kept. */
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
   * When false, no read fires, `loading` is false and `data` is `null` — for a
   * fetcher that could only answer "nothing" (a permission this viewer lacks,
   * an id not chosen yet). The alternative, a fetcher that returns `null`,
   * still schedules a full async round trip whose ONLY effect is setting
   * `loading` back to false.
   */
  enabled?: boolean;
  /**
   * Keep showing the last loaded `data` (and error) while a read for NEW deps
   * is in flight, and after `enabled` turns false.
   *
   * Off by default: `data` belongs to the deps it was read for, so a deps
   * change or `enabled` going false returns `null` from the very next render —
   * a page whose entity id changed never renders, or acts on, the previous
   * entity. Opt in only where the old answer is still a truthful placeholder
   * for the new one: paging (the previous page stays put while the next
   * loads) and a refresh-trigger dep (a counter or total that re-reads the
   * SAME record).
   */
  keepPreviousData?: boolean;
  /**
   * Shared-cache invalidation tags (see `queryTags` in `@/lib/api-cache`) this
   * read depends on. When a write calls the matching `invalidate.*` member —
   * directly or through `useMutation({ invalidates })` — the read re-runs,
   * keeping its current `data` on screen while it does, exactly as a `useQuery`
   * consumer would. Omit for a read no shared write affects.
   */
  tags?: ReadonlyArray<string>;
}

/** Element-wise `Object.is` — the comparison React applies to effect deps. */
function sameDeps(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

interface Stamped<V> { value: V; deps: ReadonlyArray<unknown> }

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
  const { enabled = true, clearDataOnError = false, keepPreviousData = false } = options;
  // Every result is stamped with the deps it was read for, and only handed back
  // while those are still the current deps — so the render right after a deps
  // change already shows `null`, rather than one frame (or, if the new read
  // fails, indefinitely) of the previous deps' answer.
  const [loaded, setLoaded] = useState<Stamped<T> | null>(null);
  const [failed, setFailed] = useState<Stamped<Error> | null>(null);
  const [settled, setSettled] = useState(!enabled);
  // The deps the in-flight (or last) run started for; a render whose deps
  // differ is a read that has not started yet, so it reports `loading`.
  const [startedFor, setStartedFor] = useState<ReadonlyArray<unknown>>(deps);
  const [tick, setTick] = useState(0);
  const tagEpoch = useTagEpoch(options.tags);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const onSuccessRef = useRef(options.onSuccess);
  onSuccessRef.current = options.onSuccess;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  // `refetch()` callers waiting for the run they triggered (or a later one) to settle.
  const waitersRef = useRef<Array<(ok: boolean) => void>>([]);

  useEffect(() => {
    const runDeps = deps;
    if (!enabled) {
      setSettled(true);
      if (!keepPreviousData) { setLoaded(null); setFailed(null); }
      return;
    }
    if (!keepPreviousData) {
      // Drop a stored answer for other deps, so going back to them later
      // can't resurface it while their re-read is in flight.
      setLoaded((prev) => (prev && sameDeps(prev.deps, runDeps) ? prev : null));
    }
    let ok = false;
    return runCancellableFetch((signal) => fetcherRef.current(signal), {
      onStart: () => {
        setStartedFor(runDeps);
        setSettled(false);
        setFailed(null);
      },
      onSuccess: (value) => {
        ok = true;
        setLoaded({ value, deps: runDeps });
        onSuccessRef.current?.(value);
      },
      onError: (err) => {
        setFailed({ value: err, deps: runDeps });
        if (clearDataOnError) setLoaded(null);
        onErrorRef.current?.(err);
      },
      onSettled: () => {
        setSettled(true);
        const waiters = waitersRef.current;
        waitersRef.current = [];
        for (const resolve of waiters) resolve(ok);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's `deps` are spread in, so the list size is not statically known
  }, [...deps, tick, tagEpoch, enabled, clearDataOnError, keepPreviousData]);

  const current = (s: Stamped<unknown> | null) =>
    !!s && (keepPreviousData || (enabled && sameDeps(s.deps, deps)));
  const data = current(loaded) ? loaded!.value : null;
  const error = current(failed) ? failed!.value : null;
  const loading = enabled && (!settled || !sameDeps(startedFor, deps));

  const refetch = useCallback(() => new Promise<boolean>((resolve) => {
    waitersRef.current.push(resolve);
    setTick((t) => t + 1);
  }), []);
  return { data, loading, error, refetch };
}
