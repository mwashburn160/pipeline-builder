// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Filter / refresh / skeleton / empty / error / "Load more" affordances are
// now provided by <ResourceList> (src/components/ui/ResourceList.tsx). This
// file only owns the grouped-namespace body + keyboard-nav imperative handle.
// Other list surfaces still using bespoke shells should also migrate; the
// open items are tagged with `migrate to <ResourceList>` comments.

import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Boxes } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { ResourceList } from '@/components/ui/ResourceList';
import type { RegistryRepoGroup } from '@/types';

interface RepositoryListProps {
  groups: RegistryRepoGroup[];
  selectedRepo: string | null;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  /** Controlled filter value — parent persists it in the URL so refresh/back keeps the search. */
  filter: string;
  onFilterChange: (value: string) => void;
  onSelect: (repoName: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}

/**
 * Imperative handle exposed for keyboard nav from the parent page —
 * lets j/k cursor movement work without lifting the entire selection
 * state into the page.
 */
export interface RepositoryListHandle {
  /** Step the selection by N rows across all visible (filtered) repos. */
  step: (delta: number) => void;
}

const NAMESPACE_TRUNCATE_AT = 24;

/**
 * Left-pane repository list for the registry page. Groups repos under
 * collapsible namespace headers (`system` first, then `org-*` alphabetical),
 * filters by free-text input, and pages via the `_catalog` cursor.
 *
 * Long namespace IDs use the platform's Tooltip primitive (so the full ID
 * is reachable for inspection without relying on the native title attribute).
 */
export const RepositoryList = forwardRef<RepositoryListHandle, RepositoryListProps>(function RepositoryList({
  groups, selectedRepo, loading, error, hasMore, filter, onFilterChange, onSelect, onLoadMore, onRefresh,
}, ref) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredGroups = useMemo(() => {
    if (!filter) return groups;
    const needle = filter.toLowerCase();
    return groups
      .map((g) => ({ ...g, repos: g.repos.filter((r) => r.name.toLowerCase().includes(needle)) }))
      .filter((g) => g.repos.length > 0);
  }, [groups, filter]);

  // Flat list of currently-visible repos — used to step the selection
  // by keyboard. Recomputed whenever filter or collapsed-state changes.
  // isOpen is a local function defined inline; its inputs (filter, collapsed)
  // are listed individually below. Adding isOpen would force a new identity
  // each render and recompute this memo every time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visibleRepoNames = useMemo(() => {
    return filteredGroups.flatMap((g) => isOpen(g.namespace) ? g.repos.map((r) => r.name) : []);
  }, [filteredGroups, filter, collapsed]);

  // Filter forces matching groups open by overriding `collapsed`.
  function isOpen(ns: string) { return !!filter || !collapsed.has(ns); }

  const toggleGroup = (ns: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
  };

  useImperativeHandle(ref, () => ({
    step: (delta: number) => {
      if (visibleRepoNames.length === 0) return;
      const idx = selectedRepo ? visibleRepoNames.indexOf(selectedRepo) : -1;
      const next = idx === -1
        ? (delta > 0 ? 0 : visibleRepoNames.length - 1)
        : Math.max(0, Math.min(visibleRepoNames.length - 1, idx + delta));
      onSelect(visibleRepoNames[next]);
      // Try to scroll the newly-selected row into view.
      requestAnimationFrame(() => {
        const el = containerRef.current?.querySelector(`[data-repo="${CSS.escape(visibleRepoNames[next])}"]`);
        (el as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
      });
    },
  }), [visibleRepoNames, selectedRepo, onSelect]);

  const truncateNs = (ns: string) =>
    ns.length > NAMESPACE_TRUNCATE_AT ? `${ns.slice(0, NAMESPACE_TRUNCATE_AT - 1)}…` : ns;

  return (
    <div ref={containerRef} className="h-full border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <ResourceList<RegistryRepoGroup>
        variant="inline"
        className="h-full"
        loading={loading}
        error={error}
        onRefresh={onRefresh}
        filter={filter}
        onFilterChange={onFilterChange}
        filterPlaceholder="Filter repos (press /)…"
        filterInputId="registry-repo-filter"
        errorTitle="Failed to load repositories"
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        isEmpty={filteredGroups.length === 0}
        emptyState={{
          icon: Boxes,
          title: 'No images yet',
          description: 'Plugin builds appear here once uploaded — typically under org-<your-id>/<plugin-name>.',
        }}
        filteredEmptyState={{
          icon: Boxes,
          title: 'No repositories match',
          description: `Nothing matches "${filter}". Clear the filter to see all repos.`,
        }}
        // When the body is empty, the shared shell renders the empty state;
        // when non-empty, we drive the grouped namespace layout below.
      >
        {filteredGroups.length > 0 && filteredGroups.map((g) => (
          <div key={g.namespace} className="border-b border-gray-100 dark:border-gray-800">
            <button
              onClick={() => toggleGroup(g.namespace)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              {isOpen(g.namespace)
                ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
                : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />}
              {g.namespace.length > NAMESPACE_TRUNCATE_AT ? (
                <Tooltip content={g.namespace}>
                  <span className="truncate cursor-help">{truncateNs(g.namespace)}</span>
                </Tooltip>
              ) : (
                <span className="truncate">{g.namespace}</span>
              )}
              <span className="ml-auto text-gray-400">({g.repos.length})</span>
            </button>
            {isOpen(g.namespace) && (
              <ul>
                {g.repos.map((r) => (
                  <li key={r.name}>
                    <button
                      data-repo={r.name}
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
      </ResourceList>
    </div>
  );
});
