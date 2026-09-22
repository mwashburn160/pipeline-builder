// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin fetching hook with module-level caching.
 * Shares a single cached plugin list across all hook instances to avoid
 * redundant API calls. Cache expires after 5 minutes.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Plugin } from '@/types';
import type { CatalogEntry, ShadowingEntry } from '@/types/plugin-installs';
import api from '@/lib/api';
import { CACHE_TTL_MS, formatError } from '@/lib/constants';
import { PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES } from '@/lib/plugin-categories';

/**
 * Module-level cache for plugin data, shared across all usePlugins instances.
 * Avoids redundant API calls when multiple components mount simultaneously.
 */
let cachedPlugins: Plugin[] | null = null;
/** Timestamp (epoch ms) of the last successful plugin fetch. */
let cacheTimestamp = 0;
/** In-flight cold-start fetch, shared so concurrent mounts don't each fire
 *  their own request against the platform service. */
let pendingFetch: Promise<Plugin[]> | null = null;
/**
 * Bumped by every {@link clearPluginCache}. An in-flight fetch captures the
 * generation it started under and only writes the cache if it still matches.
 *
 * Without this, clearing the cache did NOT cancel a request already in flight:
 * its closure still ran `cachedPlugins = fetched` after the await, REFILLING
 * the cache with the previous identity's plugins. Since `clearPluginCache` is
 * what runs on org switch, logout and session expiry — and this module state
 * survives client-side navigation — the next tenant was served the previous
 * tenant's plugin list for the full TTL.
 */
let cacheGeneration = 0;

/**
 * Invalidates the module-level plugin cache.
 * Call after creating, updating, or deleting a plugin to force a re-fetch,
 * and on any identity change (org switch, logout, session expiry).
 */
export function clearPluginCache() {
  cachedPlugins = null;
  cacheTimestamp = 0;
  pendingFetch = null;
  cachedCatalog = null;
  catalogTimestamp = 0;
  pendingCatalog = null;
  cacheGeneration += 1;
}

/**
 * The in-app catalog the pipeline editor resolves listings from, plus the
 * org's shadowing report. Same cache rules (and the same generation guard) as
 * the plugin list: after W2, `GET /plugins` returns only the org's own rows, so
 * Official and installed listings reach the editor only through here.
 */
interface CatalogSnapshot {
  entries: CatalogEntry[];
  shadowing: ShadowingEntry[];
}
let cachedCatalog: CatalogSnapshot | null = null;
let catalogTimestamp = 0;
let pendingCatalog: Promise<CatalogSnapshot> | null = null;

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
      // Coalesce concurrent cold-start callers onto a single network request.
      if (!pendingFetch) {
        const startedAt = cacheGeneration;
        pendingFetch = (async () => {
          try {
            const response = await api.listPlugins({ limit: '500', isActive: 'true' });
            const fetched = (response.data?.plugins || []) as Plugin[];
            // Only publish if the identity hasn't changed under us.
            if (startedAt === cacheGeneration) {
              cachedPlugins = fetched;
              cacheTimestamp = Date.now();
            }
            return fetched;
          } finally {
            // Don't clobber a NEWER in-flight fetch started after a clear.
            if (startedAt === cacheGeneration) pendingFetch = null;
          }
        })();
      }
      const fetched = await pendingFetch;
      setPlugins(fetched);
    } catch (err) {
      setError(formatError(err, 'Failed to load plugins'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && !fetchedRef.current) {
      fetchedRef.current = true;
      void fetchPlugins();
    }
  }, [enabled, fetchPlugins]);

  return { plugins, isLoading, error, refetch: fetchPlugins };
}

const EMPTY_CATALOG: CatalogSnapshot = { entries: [], shadowing: [] };

/**
 * Fetches and caches the org's catalog entries (every listed listing with its
 * install state) and the shadowing report. Each half fails soft on its own — a
 * catalog outage must not take the editor's own-plugin list down with it.
 */
export function usePluginCatalog(enabled = true) {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot>(cachedCatalog ?? EMPTY_CATALOG);
  const [isLoading, setIsLoading] = useState(false);
  const fetchedRef = useRef(false);

  const fetchCatalog = useCallback(async () => {
    if (cachedCatalog && Date.now() - catalogTimestamp < CACHE_TTL_MS) {
      setSnapshot(cachedCatalog);
      return;
    }
    setIsLoading(true);
    try {
      if (!pendingCatalog) {
        const startedAt = cacheGeneration;
        pendingCatalog = (async () => {
          try {
            const [catalog, shadowing] = await Promise.all([
              api.getAllPluginCatalog().catch(() => [] as CatalogEntry[]),
              api.getPluginShadowing().then((r) => r.data?.shadowing ?? []).catch(() => [] as ShadowingEntry[]),
            ]);
            const fetched = { entries: catalog, shadowing };
            if (startedAt === cacheGeneration) {
              cachedCatalog = fetched;
              catalogTimestamp = Date.now();
            }
            return fetched;
          } finally {
            if (startedAt === cacheGeneration) pendingCatalog = null;
          }
        })();
      }
      setSnapshot(await pendingCatalog);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && !fetchedRef.current) {
      fetchedRef.current = true;
      void fetchCatalog();
    }
  }, [enabled, fetchCatalog]);

  return { entries: snapshot.entries, shadowing: snapshot.shadowing, isLoading, refetch: fetchCatalog };
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
