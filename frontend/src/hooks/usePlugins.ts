/**
 * Plugin fetching hook with module-level caching.
 * Shares a single cached plugin list across all hook instances to avoid
 * redundant API calls. Cache expires after 5 minutes.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Plugin } from '@/types';
import api from '@/lib/api';
import { CACHE_TTL_MS } from '@/lib/constants';
import { PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES } from '@/lib/help';

/**
 * Module-level cache for plugin data, shared across all usePlugins instances.
 * Avoids redundant API calls when multiple components mount simultaneously.
 */
let cachedPlugins: Plugin[] | null = null;
/** Timestamp (epoch ms) of the last successful plugin fetch. */
let cacheTimestamp = 0;

/**
 * Invalidates the module-level plugin cache.
 * Call after creating, updating, or deleting a plugin to force a re-fetch.
 */
export function clearPluginCache() {
  cachedPlugins = null;
  cacheTimestamp = 0;
}

/** A group of plugins under a shared category label. */
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
 * Filters plugins by a search query and groups them by category.
 * Plugins with a `category` field are grouped by their category with display names.
 * Plugins without a category fall back to access modifier grouping.
 *
 * @param plugins - Full list of plugins to filter and group
 * @param filter - Search query string (case-insensitive); empty string skips filtering
 * @returns Grouped plugins organized by category
 */
export function groupPlugins(plugins: Plugin[], filter: string): PluginGroup[] {
  const query = filter.toLowerCase();

  const filtered = query
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          (p.description || '').toLowerCase().includes(query) ||
          p.version.toLowerCase().includes(query) ||
          (p.category || '').toLowerCase().includes(query),
      )
    : plugins;

  // Group by category (with fallback to access modifier for legacy plugins)
  const categoryMap = new Map<string, Plugin[]>();

  for (const plugin of filtered) {
    const cat = plugin.category ?? 'unknown';
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(plugin);
  }

  // Build groups in defined category order, then append any remaining
  const groups: PluginGroup[] = [];
  for (const cat of PLUGIN_CATEGORIES) {
    const plugins = categoryMap.get(cat);
    if (plugins && plugins.length > 0) {
      groups.push({ category: CATEGORY_DISPLAY_NAMES[cat], plugins });
      categoryMap.delete(cat);
    }
  }

  // Append any remaining categories not in the defined order (includes 'unknown')
  for (const [cat, plugins] of categoryMap) {
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    groups.push({ category: label, plugins });
  }

  return groups;
}
