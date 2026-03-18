import useSWR, { type SWRConfiguration } from 'swr';
import { api } from '@/lib/api';

/**
 * Generic SWR-powered data fetcher with automatic deduplication,
 * stale-while-revalidate caching, and error retry.
 *
 * @param key - Cache key (URL path or null to skip fetching)
 * @param fetcher - Async function that returns data
 * @param options - SWR configuration overrides
 *
 * @example
 * ```tsx
 * const { data, error, isLoading, mutate } = useSWRFetch(
 *   isAuthenticated ? '/api/plugins' : null,
 *   () => api.listPlugins({ limit: '50' }),
 * );
 * ```
 */
export function useSWRFetch<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options?: SWRConfiguration<T>,
) {
  return useSWR<T>(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5000, // Deduplicate identical requests within 5s
    errorRetryCount: 2,
    errorRetryInterval: 3000,
    ...options,
  });
}

/**
 * SWR hook for API endpoints that return ApiResponse format.
 * Automatically unwraps the response data.
 *
 * @example
 * ```tsx
 * const { data: plugins } = useAPIData(
 *   isAuthenticated ? 'plugins-list' : null,
 *   () => api.listPlugins({ limit: '50' }),
 * );
 * ```
 */
export function useAPIData<T>(
  key: string | null,
  fetcher: () => Promise<{ data?: T }>,
  options?: SWRConfiguration<T>,
) {
  return useSWR<T>(key, async () => {
    const response = await fetcher();
    return response.data as T;
  }, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
    errorRetryCount: 2,
    ...options,
  });
}
