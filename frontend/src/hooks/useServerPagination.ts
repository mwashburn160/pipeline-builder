// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { runCancellableFetch } from './internal/fetchCore';

interface PaginationState {
  offset: number;
  limit: number;
  total: number;
}

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
 * @example
 * const { items, pagination, loading, error, setOffset, refetch } =
 *   useServerPagination(
 *     ({ offset, limit, filters }) => api.listExemptions({ offset, limit, ...filters }),
 *     { target, result },
 *     20,
 *   );
 */
export function useServerPagination<T, F extends Record<string, unknown>>(
  fetcher: (args: { offset: number; limit: number; filters: F }) => Promise<PaginatedResult<T>>,
  filters: F,
  initialLimit = 20,
): {
  items: T[];
  pagination: PaginationState;
  loading: boolean;
  error: Error | null;
  setOffset: (offset: number) => void;
  refetch: () => void;
} {
  const [items, setItems] = useState<T[]>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    offset: 0,
    limit: initialLimit,
    total: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Reset offset when filters change. Stable comparison via JSON so the
  // dep array stays a single string and doesn't pick up object identity.
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    setPagination((p) => (p.offset === 0 ? p : { ...p, offset: 0 }));
  }, [filterKey]);

  useEffect(() => {
    return runCancellableFetch(
      () => fetcherRef.current({ offset: pagination.offset, limit: pagination.limit, filters }),
      {
        onStart: () => {
          setLoading(true);
          setError(null);
        },
        onSuccess: (result) => {
          setItems(result.items);
          setPagination((p) =>
            p.total === result.pagination.total ? p : { ...p, total: result.pagination.total },
          );
        },
        onError: setError,
        onSettled: () => setLoading(false),
      },
    );
    // filters is read via JSON key (avoids object-identity churn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.offset, pagination.limit, filterKey, tick]);

  const setOffset = useCallback(
    (offset: number) => setPagination((p) => ({ ...p, offset })),
    [],
  );
  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { items, pagination, loading, error, setOffset, refetch };
}
