// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination, type PaginationState } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SearchInput } from '@/components/ui/SearchInput';
import type { DlqJob, FailedJob } from './types';
import { buildFailureInfo } from '@/lib/plugin-vulns';

/** A failed job's error: a scan-gate refusal gets its plain-words title ahead of the raw text. */
function FailureCell({ error }: { error?: string }) {
  if (!error) return <span>—</span>;
  const info = buildFailureInfo({ message: error });
  return (
    <span className="block" title={error}>
      {info.code && <Badge color="red" className="mb-1">{info.title}</Badge>}
      <span className="line-clamp-2">{error}</span>
    </span>
  );
}

export interface FailedJobsTableProps {
  /** The CURRENT server page of jobs (the queue listings are paged server-side). */
  jobs: FailedJob[];
  /** Server pagination for the listing — offset/limit the page was read with,
   *  plus the server's total. */
  pagination: PaginationState;
  onPageChange: (offset: number) => void;
  /** Omit for a fixed page size (the size picker then offers only the current one). */
  onPageSizeChange?: (limit: number) => void;
  /** True while a page is in flight — dims the rows instead of blanking them. */
  loading?: boolean;
  title: string;
  showCategory?: boolean;
  /** When provided, renders a per-row action button (DLQ Replay / failed-build Retry). */
  onAction?: (jobId: string) => void;
  /** Job IDs with an in-flight action — disables their button. */
  actionPendingIds?: Set<string>;
  /** Button label for the idle / pending states. */
  actionLabel?: string;
  actionPendingLabel?: string;
  /** Tooltip for the action button. */
  actionTitle?: string;
}

/**
 * Server-paged table of failed (or DLQ) build jobs with an optional per-row
 * action. The server returns one newest-first page at a time; the sort headers,
 * plugin-name search and category chips refine THAT page only (and say so), so
 * they never pretend to cover jobs that haven't been fetched.
 */
export function FailedJobsTable({
  jobs, pagination, onPageChange, onPageSizeChange, loading, title, showCategory,
  onAction, actionPendingIds, actionLabel, actionPendingLabel, actionTitle,
}: FailedJobsTableProps) {
  // Page-local triage: plugin-name search + a failure-category quick-chip
  // (DLQ tables only), over the rows on screen.
  const [nameQuery, setNameQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  // Distinct failure categories present in the DLQ rows, for the quick-chips.
  const categories = useMemo(
    () => Array.from(new Set(jobs.map((j) => (j as DlqJob).failureCategory).filter(Boolean))) as string[],
    [jobs],
  );

  const filtered = useMemo(() => {
    const q = nameQuery.trim().toLowerCase();
    return jobs.filter((j) => {
      if (q && !(j.pluginName ?? '').toLowerCase().includes(q)) return false;
      if (showCategory && categoryFilter && (j as DlqJob).failureCategory !== categoryFilter) return false;
      return true;
    });
  }, [jobs, nameQuery, showCategory, categoryFilter]);

  // Sorting stays CLIENT-side (DataTable's default): the server hands back one
  // newest-first page and these headers reorder THAT page, which is what the
  // toolbar copy promises. `serverSort` would claim to order the whole set.
  const columns = useMemo<Column<FailedJob>[]>(() => {
    const cols: Column<FailedJob>[] = [
      {
        id: 'id',
        header: 'Job ID',
        cellClassName: 'font-mono text-xs text-fg-muted whitespace-nowrap',
        render: (job) => job.id?.slice(0, 12),
      },
      {
        id: 'pluginName',
        header: 'Plugin',
        cellClassName: 'text-fg font-medium',
        sortValue: (job) => job.pluginName ?? '',
        render: (job) => job.pluginName || '—',
      },
    ];

    if (showCategory) {
      cols.push({
        id: 'failureCategory',
        header: 'Category',
        render: (job) => (
          <Badge color={(job as DlqJob).failureCategory === 'permanent' ? 'red' : 'yellow'}>
            {(job as DlqJob).failureCategory || '—'}
          </Badge>
        ),
      });
    }

    cols.push(
      {
        id: 'attemptsMade',
        header: 'Attempts',
        cellClassName: 'text-fg-muted tabular-nums',
        sortValue: (job) => job.attemptsMade ?? 0,
        render: (job) => `${job.attemptsMade ?? '—'}${job.maxAttempts ? ` / ${job.maxAttempts}` : ''}`,
      },
      {
        id: 'failedAt',
        header: 'Failed at',
        cellClassName: 'text-fg-muted whitespace-nowrap',
        sortValue: (job) => job.failedAt ?? '',
        render: (job) => (job.failedAt ? <RelativeTime value={job.failedAt} /> : '—'),
      },
      {
        id: 'error',
        header: 'Error',
        cellClassName: 'text-danger text-xs max-w-xs',
        sortValue: (job) => job.error ?? '',
        render: (job) => <FailureCell error={job.error} />,
      },
    );

    if (onAction) {
      cols.push({
        id: 'actions',
        header: 'Actions',
        headerClassName: 'text-right',
        cellClassName: 'text-right whitespace-nowrap',
        locked: true,
        render: (job) => (job.contextAvailable === false ? (
          // Explicitly false only: the DLQ view omits the field, and an absent
          // value must not take the action away there.
          <span
            className="text-xs text-fg-muted"
            title="The build context was released when this build gave up, so it cannot be retried. Upload the plugin again to rebuild it."
          >
            Re-upload to rebuild
          </span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onAction(job.id)}
            disabled={actionPendingIds?.has(job.id)}
            title={actionTitle}
          >
            {actionPendingIds?.has(job.id) ? (actionPendingLabel ?? 'Working…') : (actionLabel ?? 'Retry')}
          </Button>
        )),
      });
    }

    return cols;
  }, [showCategory, onAction, actionPendingIds, actionLabel, actionPendingLabel, actionTitle]);

  const filterActive = nameQuery.trim() !== '' || (showCategory && categoryFilter !== null);

  return (
    <div>
      {/* Client-side triage toolbar: plugin-name search + failure-category chips. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput
          containerClassName="min-w-[200px]"
          value={nameQuery}
          onChange={setNameQuery}
          placeholder="Filter this page by plugin..."
          aria-label="Filter this page by plugin name"
        />
        {showCategory && categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCategoryFilter(null)}
              aria-pressed={categoryFilter === null}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                categoryFilter === null
                  ? 'border-info-border bg-info-bg text-info-strong'
                  : 'border-default text-fg-muted hover:bg-surface-muted'
              }`}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter((prev) => (prev === cat ? null : cat))}
                aria-pressed={categoryFilter === cat}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border capitalize transition-colors ${
                  categoryFilter === cat
                    ? cat === 'permanent'
                      ? 'border-danger-border bg-danger-bg text-danger'
                      : 'border-warning-border bg-warning-bg text-warning'
                    : 'border-default text-fg-muted hover:bg-surface-muted'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Dim, don't blank, while a LATER page is in flight — the rows on screen
          stay readable. Skeletons are for the first load, when there is nothing
          to keep. */}
      <div className={`transition-opacity ${loading && jobs.length > 0 ? 'opacity-60' : ''}`} aria-busy={loading || undefined}>
        <DataTable<FailedJob>
          data={filtered}
          columns={columns}
          isLoading={!!loading && jobs.length === 0}
          getRowKey={(job) => job.id}
          defaultSortColumn="failedAt"
          defaultSortDirection="desc"
          emptyState={{
            icon: Inbox,
            title: filterActive ? 'No matches on this page' : `No ${title.toLowerCase()} found`,
            description: filterActive
              ? 'The filter applies to the jobs on this page only — clear it, or page through the rest.'
              : 'Nothing has failed here.',
          }}
        />
      </div>
      {pagination.total > pagination.limit && (
        <div className="mt-3">
          <Pagination
            pagination={pagination}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange ?? (() => undefined)}
            pageSizeOptions={onPageSizeChange ? [10, 25, 50] : [pagination.limit]}
          />
        </div>
      )}
    </div>
  );
}
