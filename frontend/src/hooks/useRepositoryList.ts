// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { RegistryRepository, RegistryRepoGroup } from '@/types';

interface State {
  repos: RegistryRepository[];
  lastCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  error: Error | null;
}

const PAGE_LIMIT = 100;

/**
 * Cursor-paginated repository list for the registry page's left pane.
 *
 * Loads the first page on mount. `loadMore()` appends the next page using
 * the registry's `_catalog` cursor (last repo name from the previous batch).
 * `refresh()` resets the cursor and reloads from the beginning.
 *
 * The `groups` derivation buckets repos under namespace headers — `system`
 * first, then `org-*` alphabetical by suffix — so the UI can render
 * collapsible sections without re-deriving on each render.
 */
export function useRepositoryList() {
  const [state, setState] = useState<State>({
    repos: [],
    lastCursor: null,
    hasMore: false,
    loading: false,
    error: null,
  });

  const loadPage = useCallback(async (cursor: string | null, append: boolean) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const params: { limit: number; last?: string } = { limit: PAGE_LIMIT };
      if (cursor) params.last = cursor;
      const res = await api.listImages(params);
      const repositoriesRaw = res.data?.repositories ?? [];
      // Backend returns repository names as plain strings under the
      // `repositories` field; lift them into `RegistryRepository` shape.
      const repositories: RegistryRepository[] = repositoriesRaw.map((r) =>
        typeof r === 'string' ? { name: r } : (r as RegistryRepository),
      );
      const next = res.data?.next;
      setState((s) => ({
        repos: append ? [...s.repos, ...repositories] : repositories,
        lastCursor: repositories.length ? repositories[repositories.length - 1].name : cursor,
        hasMore: !!next,
        loading: false,
        error: null,
      }));
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err as Error }));
    }
  }, []);

  // Guard against rapid double-clicks: while a page fetch is in flight,
  // ignore subsequent `loadMore()` calls so we don't fire duplicate
  // requests for the same cursor (and append the same repos twice).
  // `hasMore` is checked too so a final-page click is also a no-op.
  const loadMore = useCallback(() => {
    if (state.loading || !state.hasMore) return;
    return loadPage(state.lastCursor, true);
  }, [loadPage, state.lastCursor, state.loading, state.hasMore]);
  const refresh = useCallback(() => loadPage(null, false), [loadPage]);

  useEffect(() => {
    void loadPage(null, false);
  }, [loadPage]);

  /**
   * Bucket repos by namespace (`system` or `org-<id>`). Repos whose name
   * has no namespace prefix fall under a synthetic `system` group so
   * they're still reachable in the UI.
   */
  const groups: RegistryRepoGroup[] = useMemo(() => {
    const map = new Map<string, RegistryRepository[]>();
    for (const repo of state.repos) {
      const slash = repo.name.indexOf('/');
      const ns = slash === -1 ? 'system' : repo.name.slice(0, slash);
      const list = map.get(ns) ?? [];
      list.push(repo);
      map.set(ns, list);
    }
    // Sort within each group alphabetically by full repo path.
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    // Namespace order: `system` first, then `org-*` alphabetical by suffix.
    const orderedKeys = [...map.keys()].sort((a, b) => {
      if (a === 'system') return -1;
      if (b === 'system') return 1;
      return a.localeCompare(b);
    });
    return orderedKeys.map((ns) => ({ namespace: ns as RegistryRepoGroup['namespace'], repos: map.get(ns)! }));
  }, [state.repos]);

  return {
    repos: state.repos,
    groups,
    hasMore: state.hasMore,
    loading: state.loading,
    error: state.error,
    loadMore,
    refresh,
  };
}
