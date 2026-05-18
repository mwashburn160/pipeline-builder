// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import { Copy, Trash2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { SkeletonTableRow } from '@/components/ui/Skeleton';
import type { TagMetadata } from '@/hooks/useTagsWithMetadata';

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

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate" title={repo}>
          {repo}
        </div>
        <label htmlFor="registry-tag-filter" className="sr-only">Filter tags</label>
        <input
          id="registry-tag-filter"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tags…"
          aria-label="Filter tags"
          className="ml-auto w-48 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh tags"
          aria-label="Refresh tags"
          className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Bulk-action toolbar — sticky just under the header when any tag is selected. */}
      {selected.size > 0 && (
        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-blue-50 dark:bg-blue-900/30 flex items-center gap-3 text-sm">
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
            className="ml-auto px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
          >
            <Trash2 className="w-3.5 h-3.5 inline mr-1" />
            Delete selected
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-3 p-3 text-sm border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 rounded">
            <div className="font-medium mb-1">Failed to load tags</div>
            <div className="text-xs mb-2">{error.message}</div>
            <button onClick={onRefresh} className="text-xs underline">Retry</button>
          </div>
        )}

        {!error && filtered.length === 0 && !loading && (
          <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
            {tags === null || tags.length === 0
              ? 'No tags in this repository.'
              : 'No tags match the filter.'}
          </div>
        )}

        {visible.length > 0 && (
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
                      {meta ? formatBytes(meta.totalSize) : enrichingMetadata ? '…' : '—'}
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

        {/* Hint when the cap truncated the rendered list — keeps the DOM bounded
            and pushes operators toward filter-driven narrowing rather than
            infinite scroll. */}
        {hiddenCount > 0 && (
          <div className="p-3 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
            Showing {visible.length} of {filtered.length} tag{filtered.length === 1 ? '' : 's'}.
            Refine the filter above to see more.
          </div>
        )}
      </div>
    </div>
  );
}

/** Human-readable bytes — keeps display tight (1024 KB → 1.0 MB → 1.0 GB). */
function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return value < 10 ? `${value.toFixed(1)} ${units[i]}` : `${Math.round(value)} ${units[i]}`;
}
