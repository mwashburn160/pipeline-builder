// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The "My plugins" list: the server-paged, URL-synced plugin list, the
 * client-side filters composed over its page (compute type, favorites only),
 * the result summary, and the write-follow-up that re-reads it.
 *
 * Owned by the page, not the tab, so the list (and the modals that act on its
 * rows) survives a tab switch.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useListPage } from '@/hooks/useListPage';
import { PLUGIN_SORT_FIELD } from '@/components/plugin/usePluginColumns';
import api from '@/lib/api';
import { PLUGIN_LIST_FIELDS, type PluginSummary } from '@/lib/api/domains/plugins';
import { mapCommonParams } from '@/lib/resource-helpers';
import { buildListSummary } from '@/lib/list-summary';
import { invalidate, queryTags } from '@/lib/api-cache';

/** `fields` for the list request — every rendered column, never the build spec. */
const LIST_FIELDS = PLUGIN_LIST_FIELDS.join(',');

interface Options {
  isAuthenticated: boolean;
  /** The URL names My plugins (see the page): only then does the list read and URL-sync. */
  mineActive: boolean;
  favorites: Set<string>;
  /** A `?q=` deep-link that seeds the name search. */
  seedQuery: string | string[] | undefined;
}

export function useMyPluginsList({ isAuthenticated, mineActive, favorites, seedQuery }: Options) {
  // Offset-paged (page numbers, page size and a URL-synced offset), so the
  // keyset `cursor` the endpoint also offers doesn't fit here; `fields` does —
  // the list never renders the build spec (commands, dockerfile, env, …).
  const list = useListPage<PluginSummary>({
    fields: [
      { key: 'name', type: 'text', defaultValue: '', primary: true },
      { key: 'id', type: 'text', defaultValue: '' },
      { key: 'orgId', type: 'text', defaultValue: '' },
      { key: 'version', type: 'text', defaultValue: '' },
      { key: 'keyword', type: 'text', defaultValue: '' },
      // Category and type are the most-used narrowing, so they sit in the
      // always-visible quick row (not counted as "advanced" filters).
      { key: 'category', type: 'select', defaultValue: 'all', primary: true },
      { key: 'pluginType', type: 'select', defaultValue: 'all', primary: true },
      { key: 'computeType', type: 'select', defaultValue: 'all' },
      { key: 'visibility', type: 'select', defaultValue: 'all' },
      { key: 'status', type: 'select', defaultValue: 'all' },
      { key: 'default', type: 'select', defaultValue: 'all' },
    ],
    // Server-side default sort mirrors the previous client-side default
    // (name ascending) so the initial view is unchanged.
    initialSort: { sortBy: 'name', sortOrder: 'asc' },
    fetcher: async (params, signal) => {
      const p: Record<string, string> = {
        ...mapCommonParams(params),
        limit: params.limit,
        offset: params.offset,
        includeTotal: 'true',
        fields: LIST_FIELDS,
      };
      if (params.name) p.name = params.name;
      if (params.id) p.id = params.id;
      if (params.orgId) p.orgId = params.orgId;
      if (params.version) p.version = params.version;
      if (params.keyword) p.keyword = params.keyword;
      if (params.category && params.category !== 'all') p.category = params.category;
      if (params.pluginType) p.pluginType = params.pluginType;
      // NOTE: computeType is intentionally NOT forwarded — PluginFilterSchema
      // strips it server-side, so it's applied as a client-side filter below.
      if (params.sortBy) p.sortBy = params.sortBy;
      if (params.sortOrder) p.sortOrder = params.sortOrder;
      const response = await api.listPlugins(p, { signal });
      return { items: response.data?.plugins || [], pagination: response.data?.pagination };
    },
    // Only the "My plugins" tab reads (and URL-syncs) the list: its write-back
    // replaces the whole query and would drop another tab's `?tab=`.
    enabled: isAuthenticated && mineActive,
    urlSync: mineActive,
    // A plugin write anywhere (upload, build, install change) re-reads the page.
    tags: [queryTags.plugins],
  });

  // Any write here re-reads this page AND drops the pipeline builder's cached
  // plugin catalog (usePlugins), which would otherwise offer a deleted or
  // deactivated plugin until its TTL ran out.
  const { refresh: refreshList } = list;
  const afterWrite = useCallback(() => { invalidate.plugins(); refreshList(); }, [refreshList]);

  // "Show favorites only" quick-chip (client-side over the fetched page).
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  // Seed the name search from a `?q=` deep-link (e.g. ⌘K "find plugin X" or a
  // My Services plugin link) so the list lands filtered to that plugin.
  // `updateFilter` is a stable callback (useListPage), so this fires on `?q=` only.
  const { updateFilter } = list;
  useEffect(() => {
    if (typeof seedQuery === 'string' && seedQuery) updateFilter('name', seedQuery);
  }, [seedQuery, updateFilter]);

  // Server-side sort: translate a column click into sortBy/sortOrder query
  // params, instead of an in-memory reorder of one page.
  const { setSort, clearFilters } = list;
  const handleServerSort = useCallback((columnId: string, direction: 'asc' | 'desc') => {
    setSort(PLUGIN_SORT_FIELD[columnId] ?? columnId, direction);
  }, [setSort]);

  // Clear both the useListPage filters and the favorites-only chip (the chip
  // is page-local state the hook doesn't know about).
  const clearAllFilters = useCallback(() => {
    clearFilters();
    setShowFavoritesOnly(false);
  }, [clearFilters]);

  // Backend returns the right scope (own org + system-public catalog). The
  // remaining client-side filters compose over that page: `computeType`
  // (PluginFilterSchema strips it, so there's no server support) and the
  // "favorites only" chip.
  const computeTypeFilter = list.filters.computeType;
  const filteredPlugins = useMemo(() => {
    let result = list.data;
    if (computeTypeFilter && computeTypeFilter !== 'all') {
      result = result.filter((p) => p.computeType === computeTypeFilter);
    }
    if (showFavoritesOnly) {
      result = result.filter((p) => favorites.has(p.id));
    }
    return result;
  }, [list.data, computeTypeFilter, showFavoritesOnly, favorites]);

  // Either an advanced/search filter or the favorites chip narrows the page.
  const hasActiveFilters = list.hasActiveFilters || showFavoritesOnly;

  // Always-on result feedback + current-page exception surfacing (server-
  // paginated, so inactive/private counts are scoped to this page).
  const listSummary = useMemo(
    () => buildListSummary(filteredPlugins, list.pagination.total, {
      noun: 'plugin',
      isLoading: list.isLoading,
      flags: [
        { label: 'inactive', pred: (p) => !p.isActive },
        { label: 'private', pred: (p) => p.visibility === 'private' },
      ],
    }),
    [filteredPlugins, list.isLoading, list.pagination.total],
  );

  return {
    list,
    refreshList,
    afterWrite,
    showFavoritesOnly,
    setShowFavoritesOnly,
    handleServerSort,
    clearAllFilters,
    filteredPlugins,
    hasActiveFilters,
    listSummary,
  };
}

export type MyPluginsList = ReturnType<typeof useMyPluginsList>;
