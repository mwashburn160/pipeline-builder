/**
 * Plugin fetching hook with module-level caching.
 * Shares a single cached plugin list across all hook instances to avoid
 * redundant API calls. Cache expires after 5 minutes.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Plugin } from '@/types';
import api from '@/lib/api';

/**
 * Module-level cache for plugin data, shared across all usePlugins instances.
 * Avoids redundant API calls when multiple components mount simultaneously.
 */
let cachedPlugins: Plugin[] | null = null;
/** Timestamp (epoch ms) of the last successful plugin fetch. */
let cacheTimestamp = 0;
/** Cache time-to-live: 5 minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Invalidates the module-level plugin cache.
 * Call after creating, updating, or deleting a plugin to force a re-fetch.
 */
export function clearPluginCache() {
  cachedPlugins = null;
  cacheTimestamp = 0;
}

/** A group of plugins under a shared category label (e.g. "Organization", "Public"). */
export interface PluginGroup {
  category: string;
  plugins: Plugin[];
}

/**
 * Fetches and caches the active plugin list.
 * Uses a module-level cache with a 5-minute TTL to minimize API calls.
 * Skips fetching if `enabled` is false.
 *
 * @param enabled - Whether to fetch plugins on mount (default: true)
 * @returns Plugin list, loading/error state, and a refetch callback
 */
export function usePlugins(enabled = true) {
  const [plugins, setPlugins] = useState<Plugin[]>(cachedPlugins || []);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchPlugins = useCallback(async () => {
    if (cachedPlugins && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
      setPlugins(cachedPlugins);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await api.listPlugins({ limit: '500', isActive: 'true' });
      const fetched = (response.data?.plugins || []) as Plugin[];
      cachedPlugins = fetched;
      cacheTimestamp = Date.now();
      setPlugins(fetched);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load plugins');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && !fetchedRef.current) {
      fetchedRef.current = true;
      fetchPlugins();
    }
  }, [enabled, fetchPlugins]);

  return { plugins, isLoading, error, refetch: fetchPlugins };
}

/**
 * Filters plugins by a search query and groups them by access modifier.
 * Matches against name, description, and version fields.
 *
 * @param plugins - Full list of plugins to filter and group
 * @param filter - Search query string (case-insensitive); empty string skips filtering
 * @returns Grouped plugins split into "Organization" (private) and "Public" categories
 */
export function groupPlugins(plugins: Plugin[], filter: string): PluginGroup[] {
  const query = filter.toLowerCase();

  const filtered = query
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          (p.description || '').toLowerCase().includes(query) ||
          p.version.toLowerCase().includes(query),
      )
    : plugins;

  const orgPlugins = filtered.filter((p) => p.accessModifier === 'private');
  const publicPlugins = filtered.filter((p) => p.accessModifier === 'public');

  const groups: PluginGroup[] = [];
  if (orgPlugins.length > 0) groups.push({ category: 'Organization', plugins: orgPlugins });
  if (publicPlugins.length > 0) groups.push({ category: 'Public', plugins: publicPlugins });
  return groups;
}
