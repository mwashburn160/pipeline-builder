// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, RefreshCw } from 'lucide-react';
import type { RegistryRepoGroup } from '@/types';

interface RepositoryListProps {
  groups: RegistryRepoGroup[];
  selectedRepo: string | null;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  onSelect: (repoName: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}

const NAMESPACE_TRUNCATE_AT = 24;

/**
 * Left-pane repository list for the registry page. Groups repos under
 * collapsible namespace headers (`system` first, then `org-*` alphabetical),
 * filters by free-text input, and pages via the `_catalog` cursor.
 *
 * Long namespace IDs (`org-019283abcdef…`) are truncated to keep the
 * sidebar readable; the full ID is in the native `title` tooltip.
 */
export function RepositoryList({
  groups, selectedRepo, loading, error, hasMore, onSelect, onLoadMore, onRefresh,
}: RepositoryListProps) {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filteredGroups = useMemo(() => {
    if (!filter) return groups;
    const needle = filter.toLowerCase();
    return groups
      .map((g) => ({ ...g, repos: g.repos.filter((r) => r.name.toLowerCase().includes(needle)) }))
      .filter((g) => g.repos.length > 0);
  }, [groups, filter]);

  // Filter forces matching groups open by overriding `collapsed`.
  const isOpen = (ns: string) => !!filter || !collapsed.has(ns);

  const toggleGroup = (ns: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
  };

  const truncateNs = (ns: string) =>
    ns.length > NAMESPACE_TRUNCATE_AT ? `${ns.slice(0, NAMESPACE_TRUNCATE_AT - 1)}…` : ns;

  return (
    <div className="flex flex-col h-full border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter repos…"
          className="flex-1 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh"
          className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-3 p-3 text-sm border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 rounded">
            <div className="font-medium mb-1">Failed to load repositories</div>
            <div className="text-xs mb-2">{error.message}</div>
            <button onClick={onRefresh} className="text-xs underline">Retry</button>
          </div>
        )}

        {!error && filteredGroups.length === 0 && !loading && (
          <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
            {filter
              ? 'No repositories match the filter.'
              : 'No images yet. Plugin builds appear here as `org-<your-id>/<plugin-name>`.'}
          </div>
        )}

        {filteredGroups.map((g) => (
          <div key={g.namespace} className="border-b border-gray-100 dark:border-gray-800">
            <button
              onClick={() => toggleGroup(g.namespace)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              title={g.namespace.length > NAMESPACE_TRUNCATE_AT ? g.namespace : undefined}
            >
              {isOpen(g.namespace)
                ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
                : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />}
              <span className="truncate">{truncateNs(g.namespace)}</span>
              <span className="ml-auto text-gray-400">({g.repos.length})</span>
            </button>
            {isOpen(g.namespace) && (
              <ul>
                {g.repos.map((r) => (
                  <li key={r.name}>
                    <button
                      onClick={() => onSelect(r.name)}
                      className={`w-full text-left px-3 py-1.5 pl-8 text-sm truncate hover:bg-gray-50 dark:hover:bg-gray-800 ${
                        selectedRepo === r.name
                          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}
                      title={r.name}
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {hasMore && !error && (
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="w-full p-3 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
