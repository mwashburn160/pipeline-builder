// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Filter input, refresh button, error block, empty-state, and the
// bounded-results "refine the filter" hint are now provided by
// <ResourceList> (src/components/ui/ResourceList.tsx). This file only owns
// the table body, multi-select state, and the bulk-action toolbar.

import { useEffect, useMemo, useState } from 'react';
import { Copy, Trash2, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Tooltip } from '@/components/ui/Tooltip';
import { SkeletonTableRow } from '@/components/ui/Skeleton';
import { ResourceList } from '@/components/ui/ResourceList';
import { useRowSelection, allSelected } from '@/components/dashboard/BulkActionBar';
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
  const { selectedIds: selected, toggle: toggleSelect, toggleAll, clear: clearSelection } = useRowSelection();

  // Clear bulk selection on repo change — multi-select doesn't make sense
  // to carry across repos.
  useEffect(() => { clearSelection(); }, [repo, clearSelection]);

  const filtered = useMemo(() => {
    return (tags ?? [])
      .filter((t) => !filter || t.toLowerCase().includes(filter.toLowerCase()))
      .sort();
  }, [tags, filter]);

  const visible = filtered.slice(0, ROW_CAP);
  const hiddenCount = Math.max(0, filtered.length - ROW_CAP);

  /** Tags currently visible AND currently selected. */
  const selectedInView = visible.filter((t) => selected.has(t));
  const allInViewSelected = allSelected(selected, visible);
  const someInViewSelected = selectedInView.length > 0 && !allInViewSelected;

  const toggleSelectAllInView = () => toggleAll(visible);

  // Empty-state copy depends on whether the repo has zero tags vs. the
  // filter excludes everything — the shared shell handles the swap via
  // `filteredEmptyState` when `filter` is non-empty.
  const repoHasNoTags = tags === null || tags.length === 0;
  const bulkBar = selected.size > 0 ? (
    <div className="ml-auto flex items-center gap-3 text-sm">
      <span className="text-info-strong font-medium">
        {selected.size} selected
      </span>
      <Button variant="link" onClick={clearSelection} className="text-xs">
        Clear
      </Button>
      <Button variant="danger" size="xs" onClick={() => onBulkDelete([...selected])}>
        <Trash2 className="w-3.5 h-3.5 inline mr-1" />
        Delete selected
      </Button>
    </div>
  ) : null;

  return (
    <ResourceList<string>
      variant="inline"
      className="h-full bg-surface"
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
        <div className="text-sm font-medium text-fg truncate" title={repo}>
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
          <thead className="bg-surface-muted sticky top-0 z-10">
            <tr>
              {/* Wider checkbox column — gives the input a comfortable hit
                  target separate from the tag name beside it. */}
              <th scope="col" className="pl-4 pr-2 py-2 w-12">
                <Tooltip content="Select all visible tags">
                  <Checkbox
                    checked={allInViewSelected}
                    ref={(el) => { if (el) el.indeterminate = someInViewSelected; }}
                    onChange={toggleSelectAllInView}
                    aria-label="Select all visible tags"
                    className="cursor-pointer"
                  />
                </Tooltip>
              </th>
              <th scope="col" className="text-left px-3 py-2 font-medium text-fg-muted">Tag</th>
              <th scope="col" className="text-left px-3 py-2 font-medium text-fg-muted">
                <Tooltip content="Manifest digest — uniquely identifies this image. Multiple tags may share one digest.">
                  <span className="cursor-help underline decoration-dotted">Digest</span>
                </Tooltip>
              </th>
              <th scope="col" className="text-left px-3 py-2 font-medium text-fg-muted">
                <Tooltip content="Total image size. For multi-arch indexes, this is the sum of per-platform manifest sizes (best-effort).">
                  <span className="cursor-help underline decoration-dotted">Size</span>
                </Tooltip>
              </th>
              <th scope="col" className="text-right px-3 py-2 font-medium text-fg-muted">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((tag) => {
              const meta = metadata?.get(tag);
              const isChecked = selected.has(tag);
              return (
                <tr
                  key={tag}
                  className={`border-t border-default hover:bg-surface-muted ${
                    selectedTag === tag ? 'bg-info-bg' : ''
                  }`}
                >
                  <td className="pl-4 pr-2 py-2">
                    <Checkbox
                      checked={isChecked}
                      onChange={() => toggleSelect(tag)}
                      aria-label={`Select ${tag}`}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onSelect(tag)}
                      className="text-left text-brand hover:underline font-mono text-xs"
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
                        <span className="font-mono text-xs text-fg-muted cursor-help">{meta.digestShort}</span>
                      </Tooltip>
                    ) : enrichingMetadata ? (
                      <span className="text-xs text-fg-subtle">…</span>
                    ) : (
                      <span className="text-xs text-fg-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-fg-muted">
                    {meta ? (meta.totalSize ? formatBytes(meta.totalSize) : '—') : enrichingMetadata ? '…' : '—'}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => onCopy(tag)}
                      title="Copy or promote this tag to another repo"
                      aria-label={`Copy ${tag}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-fg-muted hover:text-brand-strong hover:bg-info-bg rounded"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </button>
                    <button
                      onClick={() => onDelete(tag)}
                      title="Delete this tag (manifest deletion is by digest)"
                      aria-label={`Delete ${tag}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 ml-1 text-xs text-fg-muted hover:text-danger hover:bg-danger-bg rounded"
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

