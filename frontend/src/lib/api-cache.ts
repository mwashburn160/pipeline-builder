/**
 * @module lib/api-cache
 * @description SWR-based API response caching utilities.
 *
 * Wraps the existing ApiClient with SWR for automatic caching, deduplication,
 * revalidation, and stale-while-revalidate behavior.
 *
 * Usage:
 *   import { useCachedFetch } from '@/lib/api-cache';
 *   const { data, error, isLoading, mutate } = useCachedFetch('/api/plugins', () => api.listPlugins());
 */

import useSWR, { type SWRConfiguration, type KeyedMutator } from 'swr';

/** Default TTL for list endpoints (30 seconds). */
const LIST_DEDUPE_INTERVAL_MS = 30_000;

/** Default TTL for single-entity endpoints (60 seconds). */
const ENTITY_DEDUPE_INTERVAL_MS = 60_000;

/** Preset SWR configurations for common use cases. */
export const cacheProfiles = {
  /** Short-lived cache for list endpoints that change frequently. */
  list: {
    dedupingInterval: LIST_DEDUPE_INTERVAL_MS,
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
  } satisfies SWRConfiguration,

  /** Longer cache for individual entity lookups. */
  entity: {
    dedupingInterval: ENTITY_DEDUPE_INTERVAL_MS,
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
  } satisfies SWRConfiguration,

  /** Aggressive caching for rarely-changing data (e.g., config, plans). */
  stable: {
    dedupingInterval: 5 * 60 * 1000,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
  } satisfies SWRConfiguration,
} as const;

/**
 * Generic cached fetch hook powered by SWR.
 *
 * @param key   - SWR cache key (typically the API endpoint path). Pass `null` to skip fetching.
 * @param fetcher - Async function that returns the data. Uses the existing ApiClient internally.
 * @param config  - Optional SWR configuration overrides.
 * @returns SWR result with `data`, `error`, `isLoading`, and `mutate`.
 *
 * @example
 * // Basic usage
 * const { data, isLoading } = useCachedFetch('/api/plugins', () => api.listPlugins(), cacheProfiles.list);
 *
 * @example
 * // Conditional fetching (pass null key to skip)
 * const { data } = useCachedFetch(id ? `/api/plugin/${id}` : null, () => api.getPluginById(id!), cacheProfiles.entity);
 *
 * @example
 * // Invalidate cache after mutation
 * const { mutate } = useCachedFetch('/api/plugins', () => api.listPlugins());
 * await api.deletePlugin(id);
 * mutate(); // refetch
 */
export function useCachedFetch<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  config?: SWRConfiguration,
): { data: T | undefined; error: Error | undefined; isLoading: boolean; mutate: KeyedMutator<T> } {
  const { data, error, isLoading, mutate } = useSWR<T>(
    key,
    fetcher,
    {
      ...cacheProfiles.list,
      ...config,
    },
  );

  return { data, error, isLoading, mutate };
}
