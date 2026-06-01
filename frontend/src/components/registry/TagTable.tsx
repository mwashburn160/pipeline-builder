// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Filter input, refresh button, error block, empty-state, and the
// bounded-results "refine the filter" hint are now provided by
// <ResourceList> (src/components/ui/ResourceList.tsx). This file only owns
// the table body, multi-select state, and the bulk-action toolbar.

import { useEffect, useMemo, useState } from 'react';
import { Copy, Trash2, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { SkeletonTableRow } from '@/components/ui/Skeleton';
import { ResourceList } from '@/components/ui/ResourceList';
import type { TagMetadata } from '@/hooks/useTagsWithMetadata';
import { formatBytes } from '@/lib/format';

interface TagTableProps {
  repo: string;
  tags: string[] | null;
  loading: boolean;
  /** True while we're enriching tags with manifest metadata (digest, size, etc). */
  enrichingMetadata?: boolean;
  error: Error | null;
  selectedTag: string | null;
  onSelect: (tag: string) => void;
  onCopy: (tag: string) => void;
  onDelete: (tag: string) => void;
  /** Fires when the operator confirms a bulk delete via the toolbar. */
  onBulkDelete: (tags: string[]) => void;
  onRefresh: () => void;
  metadata?: Map<string, TagMetadata>;
}

/**
 * Render at most this many rows at once. Repos with more tags than this
 * (rare today, but possible as the codebase grows) show a hint asking the
 * operator to refine the filter. Avoids both the DOM-size blow-up of
 * rendering thousands of rows and the bundle overhead of a virtualization
 * library — the operational answer is "filter, don't scroll forever."
 */
const ROW_CAP = 500;

/**
 * Middle-pane tag table for the currently-selected repo.
 *
 * Multi-select via per-row checkbox + a header "select all (filtered)"
 * checkbox. When >= 1 tag is selected, a sticky toolbar appears with a
 * bulk-delete action (bulk copy is intentionally out of scope — promotions
 * usually target one image at a time).
 *
 * Multi-arch tags carry a badge; sizes are summed for index tags so the
 * operator sees a meaningful "image size" not the index manifest's
 * 600-ish bytes.
 */
export function TagTable({
  repo, tags, loading, enrichingMetadata, error, selectedTag,
  onSelect, onCopy, onDelete, onBulkDelete, onRefresh, metadata,
}: TagTableProps) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Clear bulk selection on repo change — multi-select doesn't make sense
  // to carry across repos.
  useEffect(() => { setSelected(new Set()); }, [repo]);

  const filtered = useMemo(() => {
    return (tags ?? [])
      .filter((t) => !filter || t.toLowerCase().includes(filter.toLowerCase()))
      .sort();
  }, [tags, filter]);

  const visible = filtered.slice(0, ROW_CAP);
  const hiddenCount = Math.max(0, filtered.length - ROW_CAP);

  /** Tags currently visible AND currently selected. */
  const selectedInView = visible.filter((t) => selected.has(t));
  const allInViewSelected = visible.length > 0 && selectedInView.length === visible.length;
  const someInViewSelected = selectedInView.length > 0 && !allInViewSelected;

  const toggleSelect = (tag: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const toggleSelectAllInView = () => {
    if (allInViewSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of visible) next.delete(t);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of visible) next.add(t);
        return next;
      });
    }
  };

  const clearSelection = () => setSelected(new Set());

  // Empty-state copy depends on whether the repo has zero tags vs. the
  // filter excludes everything — the shared shell handles the swap via
  // `filteredEmptyState` when `filter` is non-empty.
  const repoHasNoTags = tags === null || tags.length === 0;
  const bulkBar = selected.size > 0 ? (
    <div className="ml-auto flex items-center gap-3 text-sm">
      <span className="text-blue-700 dark:text-blue-300 font-medium">
        {selected.size} selected
      </span>
      <button
        onClick={clearSelection}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
      >
        Clear
      </button>
      <button
        onClick={() => onBulkDelete([...selected])}
        className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
      >
        <Trash2 className="w-3.5 h-3.5 inline mr-1" />
        Delete selected
      </button>
    </div>
  ) : null;

  return (
    <ResourceList<string>
      variant="inline"
      className="h-full bg-white dark:bg-gray-900"
      loading={loading}
      error={error}
      onRefresh={onRefresh}
      filter={filter}
      onFilterChange={setFilter}
      filterPlaceholder="Filter tags…"
      filterInputId="registry-tag-filter"
      errorTitle="Failed to load tags"
      // Only flip to the empty state once loading settles — during initial
      // load we let the table body render its own SkeletonTableRow rows so
      // the column headers stay visible (a nicer loading shape for tables).
      isEmpty={!loading && filtered.length === 0}
      headerStart={
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate" title={repo}>
          {repo}
        </div>
      }
      headerEnd={bulkBar}
      emptyState={{
        icon: Tag,
        title: repoHasNoTags ? 'No tags in this repository.' : 'No tags match the filter.',
        description: repoHasNoTags
          ? 'Push an image to this repo to see tags here.'
          : 'Adjust the filter above to widen the search.',
      }}
      filteredEmptyState={{
        icon: Tag,
        title: 'No tags match the filter.',
        description: 'Adjust the filter above to widen the search.',
      }}
      cappedHint={hiddenCount > 0
        ? `Showing ${visible.length} of ${filtered.length} tag${filtered.length === 1 ? '' : 's'}. Refine the filter above to see more.`
        : undefined}
    >
      {(visible.length > 0 || loading) && (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0 z-10">
            <tr>
              {/* Wider checkbox column — gives the input a comfortable hit
                  target separate from the tag name beside it. */}
              <th className="pl-4 pr-2 py-2 w-12">
                <Tooltip content="Select all visible tags">
                  <input
                    type="checkbox"
                    checked={allInViewSelected}
                    ref={(el) => { if (el) el.indeterminate = someInViewSelected; }}
                    onChange={toggleSelectAllInView}
                    aria-label="Select all visible tags"
                    className="rounded cursor-pointer"
                  />
                </Tooltip>
              </th>
              <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300">Tag</th>
              <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300">
                <Tooltip content="Manifest digest — uniquely identifies this image. Multiple tags may share one digest.">
                  <span className="cursor-help underline decoration-dotted">Digest</span>
                </Tooltip>
              </th>
              <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300">
                <Tooltip content="Total image size. For multi-arch indexes, this is the sum of per-platform manifest sizes (best-effort).">
                  <span className="cursor-help underline decoration-dotted">Size</span>
                </Tooltip>
              </th>
              <th className="text-right px-3 py-2 font-medium text-gray-700 dark:text-gray-300">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((tag) => {
              const meta = metadata?.get(tag);
              const isChecked = selected.has(tag);
              return (
                <tr
                  key={tag}
                  className={`border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 ${
                    selectedTag === tag ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                  }`}
                >
                  <td className="pl-4 pr-2 py-2">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleSelect(tag)}
                      aria-label={`Select ${tag}`}
                      className="rounded cursor-pointer"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onSelect(tag)}
                      className="text-left text-blue-600 dark:text-blue-400 hover:underline font-mono text-xs"
                    >
                      {tag}
                    </button>
                    {meta?.isMultiArch && (
                      <Badge color="purple" className="ml-2">multi-arch</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {meta ? (
                      <Tooltip content={meta.digest}>
                        <span className="font-mono text-xs text-gray-500 dark:text-gray-400 cursor-help">{meta.digestShort}</span>
                      </Tooltip>
                    ) : enrichingMetadata ? (
                      <span className="text-xs text-gray-400">…</span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                    {meta ? (meta.totalSize ? formatBytes(meta.totalSize) : '—') : enrichingMetadata ? '…' : '—'}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => onCopy(tag)}
                      title="Copy or promote this tag to another repo"
                      aria-label={`Copy ${tag}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </button>
                    <button
                      onClick={() => onDelete(tag)}
                      title="Delete this tag (manifest deletion is by digest)"
                      aria-label={`Delete ${tag}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 ml-1 text-xs text-gray-700 dark:text-gray-300 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 rounded"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete</span>
                    </button>
                  </td>
                </tr>
              );
            })}
            {loading && visible.length === 0 && (
              <>
                <SkeletonTableRow columns={5} />
                <SkeletonTableRow columns={5} />
                <SkeletonTableRow columns={5} />
              </>
            )}
          </tbody>
        </table>
      )}
    </ResourceList>
  );
}

