// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * <ResourceList> — shared shell for "list of things" surfaces.
 *
 * Consolidates four divergent patterns that grew up independently across
 * the Pipeline, Plugin, and Registry surfaces:
 *
 *   1. Pipeline/Plugin list pages (pages/dashboard/{pipelines,plugins}.tsx)
 *      — useListPage + DataTable + Pagination + manual error alert
 *      — offset-based pagination
 *
 *   2. RepositoryList (src/components/registry/RepositoryList.tsx)
 *      — filter input + refresh button + per-component skeleton/empty/error
 *      — cursor-based "Load more"
 *
 *   3. TagTable (src/components/registry/TagTable.tsx)
 *      — filter input + refresh button + ROW_CAP slice with "refine the filter"
 *        hint when results exceed the cap
 *
 *   4. DeployedPipelinesPanel (src/components/pipeline/DeployedPipelinesPanel.tsx)
 *      — inline list of registry rows with refresh button + ad-hoc empty/error
 *
 * Each invented its own skeleton-during-load logic, empty-state copy,
 * error-with-retry block, and refresh-button affordance. This component
 * unifies those slots behind a single shape so consumers stop reinventing
 * them — and bug fixes (a11y, retry behavior, focus management) land in
 * one place.
 *
 * Design principles:
 *   - Composition over inheritance: caller supplies the body (children, or
 *     `data + columns` for the common table case).
 *   - Doesn't dictate fetching: caller passes `loading / error / onRefresh`.
 *   - Pagination is optional and mutually exclusive — cursor-based
 *     (`hasMore + onLoadMore`) OR offset-based (`pagination + onPageChange`).
 *   - Bounded-results hint (`cappedHint`) covers the TagTable case where
 *     results exceed an in-component slice cap.
 */

import { type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DataTable, type Column } from './DataTable';
import { Pagination, type PaginationState } from './Pagination';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';

export interface ResourceListProps<T> {
  // ── Required state ──
  /** True while a fetch is in flight. Drives skeleton + refresh-spinner. */
  loading: boolean;
  /** Latest fetch error, or `null` when healthy. */
  error: Error | string | null;
  /** Re-run the fetch. Wired into the refresh button + the error-state retry. */
  onRefresh: () => void;

  // ── Body: either pass `data + columns` (table mode) OR `children` (custom) ──
  /** Items to render in table mode. */
  data?: T[];
  /** Column defs for table mode. */
  columns?: Column<T>[];
  /** Stable row key extractor for table mode. */
  getRowKey?: (item: T, index: number) => string;
  /** Custom body — used when the caller doesn't fit the table shape (grouped lists, etc). */
  children?: ReactNode;
  /**
   * For custom-body callers: explicitly signal that the body has zero items
   * so the shared shell can switch to the empty state. Table-mode callers
   * don't need this — `data.length` is used automatically.
   */
  isEmpty?: boolean;

  // ── Filter slot ──
  /**
   * Controlled filter value. When provided alongside `onFilterChange`,
   * ResourceList renders a built-in filter input in the header.
   * Omit both to render no filter (or pass `filterSlot` for a custom one).
   */
  filter?: string;
  onFilterChange?: (value: string) => void;
  filterPlaceholder?: string;
  /** Stable id for the filter input (a11y label hookup). */
  filterInputId?: string;
  /** Replace the built-in filter input entirely (e.g. caller wants `<FilterBar>`). */
  filterSlot?: ReactNode;

  // ── Header extras ──
  /** Rendered to the left of the filter input — typically a title. */
  headerStart?: ReactNode;
  /** Rendered between filter and refresh button — bulk-action toolbars, etc. */
  headerEnd?: ReactNode;
  /** Hide the built-in refresh button (rare — use when caller renders its own). */
  hideRefresh?: boolean;

  // ── Empty / loading copy ──
  /** Empty-state shown when not loading, no error, and body has 0 rows. */
  emptyState: {
    icon: LucideIcon;
    title: string;
    description: string;
    action?: ReactNode;
  };
  /**
   * Override the empty-state when a filter is active. Lets callers show
   * "Nothing matches X — clear the filter" copy without rebuilding the
   * empty state from scratch.
   */
  filteredEmptyState?: {
    icon: LucideIcon;
    title: string;
    description: string;
    action?: ReactNode;
  };
  /** Header for the error block. Default: "Failed to load". */
  errorTitle?: string;
  /** Number of skeleton lines to render during initial load (non-table mode). */
  skeletonLines?: number;

  // ── Footer: cursor pagination OR offset pagination OR cap-hint (mutually exclusive) ──
  /** Cursor-paged mode: more pages exist beyond what's currently rendered. */
  hasMore?: boolean;
  /** Cursor-paged mode: fetch the next page. */
  onLoadMore?: () => void;

  /** Offset-paged mode. */
  pagination?: PaginationState;
  onPageChange?: (offset: number) => void;
  onPageSizeChange?: (limit: number) => void;

  /**
   * Bounded-results hint. Shown after the body when a parent component has
   * sliced its result set to a cap and wants to push the operator toward
   * filter-driven narrowing (the TagTable case).
   */
  cappedHint?: ReactNode;

  // ── Misc ──
  /** Extra classes on the root container. */
  className?: string;
  /**
   * Layout mode. `'card'` (default) wraps the list in a bordered panel
   * suitable for full-page surfaces. `'inline'` is for embedding inside
   * an existing card (no outer border) — used by DeployedPipelinesPanel.
   */
  variant?: 'card' | 'inline';
}

/**
 * Decides whether the body is "empty" — used to switch into the empty
 * state. In table mode we look at `data.length`; in custom-body mode the
 * caller passes `isEmpty` explicitly (because we can't introspect children).
 */
function isBodyEmpty<T>(
  data: T[] | undefined,
  hasCustomBody: boolean,
  isEmptyOverride: boolean | undefined,
): boolean {
  if (hasCustomBody) return isEmptyOverride === true;
  return !data || data.length === 0;
}

/** Shared shell for list/table surfaces — see file-level docstring. */
export function ResourceList<T>({
  loading,
  error,
  onRefresh,
  data,
  columns,
  getRowKey,
  children,
  isEmpty,
  filter,
  onFilterChange,
  filterPlaceholder = 'Filter…',
  filterInputId,
  filterSlot,
  headerStart,
  headerEnd,
  hideRefresh = false,
  emptyState,
  filteredEmptyState,
  errorTitle = 'Failed to load',
  skeletonLines = 6,
  hasMore,
  onLoadMore,
  pagination,
  onPageChange,
  onPageSizeChange,
  cappedHint,
  className = '',
  variant = 'card',
}: ResourceListProps<T>) {
  const errorMessage = error instanceof Error ? error.message : error;
  const hasCustomBody = children !== undefined;
  const showBuiltInFilter = filterSlot === undefined && filter !== undefined && onFilterChange !== undefined;
  const hasFilterText = !!(filter && filter.length > 0);

  // The body is "empty" when there's nothing to render and we're not loading.
  // The empty state should override the body — render either body OR empty,
  // never both.
  const bodyEmpty = isBodyEmpty(data, hasCustomBody, isEmpty);
  const showEmptyState = !loading && !error && bodyEmpty;
  const activeEmptyState = hasFilterText && filteredEmptyState ? filteredEmptyState : emptyState;

  // Skeleton placeholders for non-table custom-body mode during initial
  // load. Table mode delegates to DataTable's built-in skeleton.
  const showCustomSkeleton = loading && hasCustomBody && bodyEmpty && !error;

  const rootClass = variant === 'card'
    ? `flex flex-col border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 rounded-lg ${className}`
    : `flex flex-col ${className}`;

  return (
    <div className={rootClass}>
      {/* ── Header ── */}
      {(headerStart || showBuiltInFilter || filterSlot || headerEnd || !hideRefresh) && (
        <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
          {headerStart}
          {filterSlot}
          {showBuiltInFilter && (
            <>
              {filterInputId && (
                <label htmlFor={filterInputId} className="sr-only">{filterPlaceholder}</label>
              )}
              <input
                id={filterInputId}
                type="text"
                value={filter}
                onChange={(e) => onFilterChange(e.target.value)}
                placeholder={filterPlaceholder}
                aria-label={filterPlaceholder}
                className="flex-1 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
            </>
          )}
          {headerEnd}
          {!hideRefresh && (
            <button
              onClick={onRefresh}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh"
              className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
      )}

      {/* ── Body ── */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-3 p-3 text-sm border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 rounded">
            <div className="font-medium mb-1">{errorTitle}</div>
            {errorMessage && <div className="text-xs mb-2">{errorMessage}</div>}
            <button onClick={onRefresh} className="text-xs underline">Retry</button>
          </div>
        )}

        {showCustomSkeleton && (
          <div className="p-3 space-y-2">
            {Array.from({ length: skeletonLines }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        )}

        {!error && showEmptyState && (
          <div className="px-4">
            <EmptyState {...activeEmptyState} />
          </div>
        )}

        {!error && !showEmptyState && (
          <>
            {/* Table mode */}
            {columns && data && (
              <DataTable
                data={data}
                columns={columns}
                isLoading={loading}
                getRowKey={getRowKey}
                emptyState={activeEmptyState}
              />
            )}
            {/* Custom-body mode */}
            {hasCustomBody && children}
          </>
        )}

        {/* Cursor-paged "Load more" — only shown when we actually have a body. */}
        {hasMore && !error && onLoadMore && (
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="w-full p-3 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}

        {/* Bounded-results hint (e.g. TagTable's ROW_CAP slice). */}
        {cappedHint && !error && (
          <div className="p-3 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
            {cappedHint}
          </div>
        )}
      </div>

      {/* Offset-paged Pagination — rendered outside the scroll body so it
          stays visible at the bottom. */}
      {pagination && onPageChange && onPageSizeChange && !error && pagination.total > 0 && (
        <Pagination
          pagination={pagination}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      )}
    </div>
  );
}
