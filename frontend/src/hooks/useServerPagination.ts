// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { runCancellableFetch } from './internal/fetchCore';
import { DEFAULT_PAGE_SIZE, usePagination } from './usePagination';
import type { PaginationState } from '@/components/ui/Pagination';

interface PaginatedResult<T> {
  items: T[];
  pagination: { offset: number; limit: number; total: number };
}

/**
 * Server-paginated list state + fetch loop. Consolidates the
 * filter-state → reset-offset-on-filter-change → fetch-on-offset/filter-change
 * → reconcile-server-pagination-into-local-state pattern repeated across the
 * compliance, exemption, scan, and rule-scan components (~25 lines × 4).
 *
 * `filters` is a stable object key — when its serialized value changes the
 * offset resets to 0 and a refetch is triggered. The fetcher is read via a
 * ref so callers don't need to memoize it.
 *
 * The page triple, the page-size default and the clamp rule all come from
 * {@link usePagination} — see its module doc for why that is the one
 * server-pagination convention.
 *
 * @example
 * const { items, pagination, loading, error, setOffset, refetch } =
 *   useServerPagination(
 *     ({ offset, limit, filters }) => api.getExemptions({ offset, limit, ...filters }),
 *     { target, result },
 *     20,
 *   );
 */
export function useServerPagination<T, F extends Record<string, unknown>>(
  /** `signal` aborts when the filters/page change or the consumer unmounts —
   *  forward it to the API client to cancel the superseded page on the wire. */
  fetcher: (args: { offset: number; limit: number; filters: F; signal: AbortSignal }) => Promise<PaginatedResult<T>>,
  filters: F,
  initialLimit: number = DEFAULT_PAGE_SIZE,
): {
  items: T[];
  pagination: PaginationState;
  loading: boolean;
  error: Error | null;
  setOffset: (offset: number) => void;
  /** Change the rows-per-page; returns to page 1, like every other list. */
  setLimit: (limit: number) => void;
  refetch: () => void;
} {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const page = usePagination(initialLimit);
  const { offset, limit, setOffset, setLimit, reset } = page;
  const pagination = page.withTotal(total);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Reset the offset when the filters change — DURING render, so the fetch
  // effect sees the new filters and offset 0 together and issues one request.
  // (Resetting in a separate effect would first fetch the new filters at the
  // stale offset.) Compared by JSON so object identity
  // doesn't count as a change.
  const filterKey = JSON.stringify(filters);
  const [shownFilterKey, setShownFilterKey] = useState(filterKey);
  if (shownFilterKey !== filterKey) {
    setShownFilterKey(filterKey);
    reset();
  }

  useEffect(() => {
    return runCancellableFetch(
      (signal) => fetcherRef.current({ offset, limit, filters, signal }),
      {
        onStart: () => {
          setLoading(true);
          setError(null);
        },
        onSuccess: (result) => {
          setItems(result.items);
          // `usePagination` clamps against this, so a filter that shrank the set
          // while the viewer was on a later page snaps back to a real page.
          setTotal(result.pagination.total);
        },
        onError: setError,
        onSettled: () => setLoading(false),
      },
    );
    // filters is read via JSON key (avoids object-identity churn)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `filters` is tracked by its JSON key, which avoids object-identity churn
  }, [offset, limit, filterKey, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { items, pagination, loading, error, setOffset, setLimit, refetch };
}
