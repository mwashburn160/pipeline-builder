// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline editor's plugin sources, read through the shared query cache:
 * concurrent mounts share one request, the answer is kept for `CACHE_TTL_MS`,
 * `invalidate.plugins()` re-reads every mounted consumer, and the identity-
 * boundary reset (`clearQueryCache`) drops it with everything else.
 */
import { useQuery } from '@/hooks/useQuery';
import { Plugin } from '@/types';
import { queries } from '@/lib/api-cache';
import { formatError } from '@/lib/constants';
import { PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES } from '@/lib/plugin-categories';

/** A group of plugins under a shared category label. */
export interface PluginGroup {
  category: string;
  plugins: Plugin[];
}

/**
 * The org's active plugins. Idle while `enabled` is false.
 */
export function usePlugins(enabled = true) {
  const { data, loading, error, refetch } = useQuery(queries.activePlugins(), { enabled });
  return {
    plugins: data ?? [],
    isLoading: loading,
    error: error ? formatError(error, 'Failed to load plugins') : null,
    refetch,
  };
}

/**
 * The org's catalog entries and shadowing report. Idle while `enabled` is false.
 */
export function usePluginCatalog(enabled = true) {
  const { data, loading, refetch } = useQuery(queries.pluginCatalog(), { enabled });
  return { entries: data?.entries ?? [], shadowing: data?.shadowing ?? [], isLoading: loading, refetch };
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

  const categoryMap = new Map<string, Plugin[]>();

  for (const plugin of filtered) {
    const cat = plugin.category ?? 'unknown';
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(plugin);
  }

  // Build groups in defined category order, then append any remaining
  const groups: PluginGroup[] = [];
  for (const cat of PLUGIN_CATEGORIES) {
    const inCategory = categoryMap.get(cat);
    if (inCategory && inCategory.length > 0) {
      groups.push({ category: CATEGORY_DISPLAY_NAMES[cat], plugins: inCategory });
      categoryMap.delete(cat);
    }
  }

  // Append any remaining categories not in the defined order (includes 'unknown')
  for (const [cat, rest] of categoryMap) {
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    groups.push({ category: label, plugins: rest });
  }

  return groups;
}
