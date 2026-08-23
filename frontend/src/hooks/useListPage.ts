// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/router';
import { useDebounce } from './useDebounce';
import { runCancellableFetch } from './internal/fetchCore';
import { formatError } from '@/lib/constants';
import type { PaginationState } from '@/components/ui/Pagination';

// ─── Types ──────────────────────────────────────────────

export interface FilterField {
  /** Filter key name */
  key: string;
  /** 'text' fields are debounced; 'select' fields trigger immediately */
  type: 'text' | 'select';
  /** Default/initial value */
  defaultValue: string;
  /** If true, excluded from advancedFilterCount (e.g. primary search bar) */
  primary?: boolean;
}

export interface UseListPageOptions<T> {
  /** Filter field definitions */
  fields: FilterField[];
  /** Async function that fetches data given params */
  fetcher: (params: Record<string, string>) => Promise<{
    items: T[];
    pagination?: { total: number; offset: number };
  }>;
  /** Whether fetching is allowed (e.g. isAuthenticated) */
  enabled?: boolean;
  /** Initial page size */
  pageSize?: number;
  /** Debounce delay for text fields in ms */
  debounceMs?: number;
  /** Build additional params from current filter values */
  buildParams?: (filters: Record<string, string>) => Record<string, string>;
  /**
   * Initial server-side sort. When set, `sortBy`/`sortOrder` are sent with the
   * very first fetch (and reflected in the returned sort state). Consumers that
   * don't opt into server-side sorting omit this and no sort params are sent.
   */
  initialSort?: { sortBy: string; sortOrder: string };
  /**
   * Opt into URL query-string sync: hydrate the initial filter/sort/offset state
   * from `router.query` on mount, and mirror changes back via a shallow
   * `router.replace` (debounced with the fetch). Makes the list state survive
   * refresh and be shareable. Off by default so pages adopt it deliberately.
   */
  urlSync?: boolean;
}

export interface UseListPageResult<T> {
  data: T[];
  isLoading: boolean;
  error: string | null;
  setError: (msg: string | null) => void;
  filters: Record<string, string>;
  updateFilter: (key: string, value: string) => void;
  clearFilters: () => void;
  hasActiveFilters: boolean;
  advancedFilterCount: number;
  pagination: PaginationState;
  handlePageChange: (offset: number) => void;
  handlePageSizeChange: (limit: number) => void;
  refresh: () => void;
  /** Current server-side sort field ('' when unset). */
  sortBy: string;
  /** Current server-side sort direction ('' when unset). */
  sortOrder: string;
  /** Set the server-side sort. Triggers a refetch and resets to page 0. */
  setSort: (sortBy: string, sortOrder: string) => void;
}

// ─── Hook ───────────────────────────────────────────────

/**
 * Generic hook for paginated, filterable list pages.
 * Handles filter state, debouncing, pagination, and data fetching.
 *
 * @example
 * ```tsx
 * const list = useListPage<Pipeline>({
 *   fields: [
 *     { key: 'name', type: 'text', defaultValue: '', primary: true },
 *     { key: 'status', type: 'select', defaultValue: 'all' },
 *   ],
 *   fetcher: async (params) => {
 *     const res = await api.listPipelines(params);
 *     return { items: res.data?.pipelines || [], pagination: res.data?.pagination };
 *   },
 *   enabled: isAuthenticated,
 * });
 * ```
 */
export function useListPage<T>(options: UseListPageOptions<T>): UseListPageResult<T> {
  const { fields, fetcher, enabled = true, pageSize = 25, debounceMs = 300, buildParams, initialSort, urlSync = false } = options;
  const router = useRouter();
  // One-shot guard: hydrate from the URL exactly once (before write-back begins),
  // so the mirror-to-URL effect can't feed back into hydration and loop.
  const hydratedRef = useRef(false);

  // Build initial filter state from field definitions
  const initialFilters: Record<string, string> = {};
  for (const f of fields) {
    initialFilters[f.key] = f.defaultValue;
  }

  const [filters, setFilters] = useState<Record<string, string>>(initialFilters);
  const [data, setData] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `total` is driven by the server response, `limit`/`offset` by the user;
  // keep them split so we don't bounce pagination state on every fetch.
  const [total, setTotal] = useState(0);
  const [pageState, setPageState] = useState<{ limit: number; offset: number }>({ limit: pageSize, offset: 0 });
  // Server-side sort. Empty strings mean "unset" — no sort params are sent,
  // preserving behavior for consumers that don't opt in.
  const [sortState, setSortState] = useState<{ sortBy: string; sortOrder: string }>(
    initialSort ?? { sortBy: '', sortOrder: '' },
  );
  const pagination: PaginationState = useMemo(
    () => ({ ...pageState, total }),
    [pageState, total],
  );
  const [fetchKey, setFetchKey] = useState(0);

  // Memoize field key arrays to avoid recalculating on every render
  const textFieldKeys = useMemo(() => fields.filter(f => f.type === 'text').map(f => f.key), [fields]);
  const selectFieldKeys = useMemo(() => fields.filter(f => f.type === 'select').map(f => f.key), [fields]);

  // Debounce all text filter values as a single JSON string to avoid multiple hooks
  const textValues = useMemo(() => JSON.stringify(textFieldKeys.map(k => filters[k])), [textFieldKeys, filters]);
  const debouncedTextValues = useDebounce(textValues, debounceMs);

  // Parse debounced text values back — memoized to avoid object recreation
  const debouncedFilters = useMemo(() => {
    const result: Record<string, string> = { ...filters };
    try {
      const parsed = JSON.parse(debouncedTextValues) as string[];
      textFieldKeys.forEach((key, i) => {
        result[key] = parsed[i];
      });
    } catch {
      // Use raw filter values if parse fails
    }
    return result;
  }, [debouncedTextValues, textFieldKeys, filters]);

  // Reset to page 0 when filters or sort change
  useEffect(() => {
    setPageState(prev => prev.offset === 0 ? prev : { ...prev, offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectFieldKeys is static config; only filter values matter
  }, [debouncedTextValues, ...selectFieldKeys.map(k => filters[k]), sortState.sortBy, sortState.sortOrder]);

  // Fetch data when debounced filters, pagination, or fetchKey change. Shares
  // the cancellable-fetch core with useFetch/useServerPagination so the
  // "drop stale state writes on deps-change/unmount" semantics live in one place.
  useEffect(() => {
    // Clear the initial loading state when disabled so a consumer gating on a
    // non-auth condition (e.g. "wait for an id") doesn't render a spinner
    // forever; `isLoading` inits true for the enabled-from-mount common case.
    if (!enabled) { setIsLoading(false); return; }

    // Build params from debounced filter values
    const params: Record<string, string> = {};
    for (const f of fields) {
      const val = f.type === 'text' ? (debouncedFilters[f.key] ?? '').trim() : filters[f.key];
      if (val && val !== f.defaultValue) {
        params[f.key] = val;
      }
    }

    // Apply custom param transformations
    const finalParams = buildParams ? { ...params, ...buildParams(debouncedFilters) } : params;

    // Add pagination
    finalParams.limit = String(pageState.limit);
    finalParams.offset = String(pageState.offset);

    // Add server-side sort (only when opted into — empty means unset)
    if (sortState.sortBy) finalParams.sortBy = sortState.sortBy;
    if (sortState.sortOrder) finalParams.sortOrder = sortState.sortOrder;

    return runCancellableFetch(() => fetcher(finalParams), {
      onStart: () => setIsLoading(true),
      onSuccess: (result) => {
        setData(result.items);
        if (result.pagination) {
          setTotal(result.pagination.total);
          // Only sync offset if the server returned a different one (e.g.
          // clamped to last page) — avoids a redundant re-render loop.
          setPageState(prev => prev.offset === result.pagination!.offset
            ? prev
            : { ...prev, offset: result.pagination!.offset });
        }
        setError(null);
      },
      // fetchCore normalizes the throw to an Error; formatError extracts its
      // message, preserving this hook's `error: string` contract.
      onError: (err) => setError(formatError(err, 'Failed to load data')),
      onSettled: () => setIsLoading(false),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectFieldKeys is static config; dynamic filter values are spread individually
  }, [enabled, debouncedTextValues, ...selectFieldKeys.map(k => filters[k]), pageState.limit, pageState.offset, sortState.sortBy, sortState.sortOrder, fetchKey]);

  // URL → state (once, when the router is ready). Reads any managed filter keys,
  // sortBy/sortOrder, and offset from the query so a refresh/shared link restores
  // the view. Runs before the write-back effect can fire (hydratedRef guard).
  useEffect(() => {
    if (!urlSync || !router.isReady || hydratedRef.current) return;
    hydratedRef.current = true;
    const q = router.query;
    const nextFilters: Record<string, string> = { ...initialFilters };
    let filtersChanged = false;
    for (const f of fields) {
      const v = q[f.key];
      if (typeof v === 'string' && v !== f.defaultValue) { nextFilters[f.key] = v; filtersChanged = true; }
    }
    if (filtersChanged) setFilters(nextFilters);
    const sb = typeof q.sortBy === 'string' ? q.sortBy : '';
    const so = typeof q.sortOrder === 'string' ? q.sortOrder : '';
    if (sb || so) setSortState({ sortBy: sb, sortOrder: so });
    const off = typeof q.offset === 'string' ? parseInt(q.offset, 10) : NaN;
    if (Number.isFinite(off) && off > 0) setPageState(prev => ({ ...prev, offset: off }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot hydration keyed on router readiness.
  }, [urlSync, router.isReady]);

  // state → URL (after hydration). Mirrors the settled (debounced) filter/sort/
  // offset state into a shallow `router.replace`. Deps are the same settled values
  // the fetch uses, so it writes at most once per settled change — never per keystroke.
  useEffect(() => {
    if (!urlSync || !hydratedRef.current) return;
    const query: Record<string, string> = {};
    for (const f of fields) {
      const val = (f.type === 'text' ? debouncedFilters[f.key] : filters[f.key]) ?? '';
      if (val && val !== f.defaultValue) query[f.key] = val;
    }
    if (sortState.sortBy) query.sortBy = sortState.sortBy;
    if (sortState.sortOrder) query.sortOrder = sortState.sortOrder;
    if (pageState.offset > 0) query.offset = String(pageState.offset);
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectFieldKeys static; settled values spread individually.
  }, [urlSync, debouncedTextValues, ...selectFieldKeys.map(k => filters[k]), sortState.sortBy, sortState.sortOrder, pageState.offset]);

  const updateFilter = useCallback((key: string, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(initialFilters);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialFilters is only used on mount to reset state
  }, []);

  const hasActiveFilters = useMemo(() => fields.some(f => {
    const val = filters[f.key];
    return f.type === 'select' ? val !== f.defaultValue : val !== '';
  }), [fields, filters]);

  const advancedFilterCount = useMemo(() => fields.filter(f => {
    if (f.primary) return false;
    const val = filters[f.key];
    return f.type === 'select' ? val !== f.defaultValue : val !== '';
  }).length, [fields, filters]);

  const handlePageChange = useCallback((offset: number) => {
    setPageState(prev => prev.offset === offset ? prev : { ...prev, offset });
  }, []);

  const handlePageSizeChange = useCallback((limit: number) => {
    setPageState(prev => prev.limit === limit ? prev : { ...prev, limit, offset: 0 });
  }, []);

  const refresh = useCallback(() => setFetchKey(k => k + 1), []);

  const setSort = useCallback((sortBy: string, sortOrder: string) => {
    setSortState(prev => (prev.sortBy === sortBy && prev.sortOrder === sortOrder ? prev : { sortBy, sortOrder }));
  }, []);

  return {
    data,
    isLoading,
    error,
    setError,
    filters,
    updateFilter,
    clearFilters,
    hasActiveFilters,
    advancedFilterCount,
    pagination,
    handlePageChange,
    handlePageSizeChange,
    refresh,
    sortBy: sortState.sortBy,
    sortOrder: sortState.sortOrder,
    setSort,
  };
}
