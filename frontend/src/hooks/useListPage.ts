import { useState, useCallback, useEffect, useMemo } from 'react';
import { useDebounce } from './useDebounce';
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
  const { fields, fetcher, enabled = true, pageSize = 25, debounceMs = 300, buildParams } = options;

  // Build initial filter state from field definitions
  const initialFilters: Record<string, string> = {};
  for (const f of fields) {
    initialFilters[f.key] = f.defaultValue;
  }

  const [filters, setFilters] = useState<Record<string, string>>(initialFilters);
  const [data, setData] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PaginationState>({ limit: pageSize, offset: 0, total: 0 });
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

  // Reset to page 0 when filters change
  useEffect(() => {
    setPagination(prev => prev.offset === 0 ? prev : { ...prev, offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedTextValues, ...selectFieldKeys.map(k => filters[k])]);

  // Fetch data when debounced filters, pagination, or fetchKey change
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function doFetch() {
      setIsLoading(true);
      try {
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
        finalParams.limit = String(pagination.limit);
        finalParams.offset = String(pagination.offset);

        const result = await fetcher(finalParams);
        if (!cancelled) {
          setData(result.items);
          if (result.pagination) {
            setPagination(prev => ({ ...prev, total: result.pagination!.total, offset: result.pagination!.offset }));
          }
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(formatError(err, 'Failed to load data'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    doFetch();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, debouncedTextValues, ...selectFieldKeys.map(k => filters[k]), pagination.limit, pagination.offset, fetchKey]);

  const updateFilter = useCallback((key: string, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(initialFilters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setPagination(prev => ({ ...prev, offset }));
  }, []);

  const handlePageSizeChange = useCallback((limit: number) => {
    setPagination(prev => ({ ...prev, limit, offset: 0 }));
  }, []);

  const refresh = useCallback(() => setFetchKey(k => k + 1), []);

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
  };
}
