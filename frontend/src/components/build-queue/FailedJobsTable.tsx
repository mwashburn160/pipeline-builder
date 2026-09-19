// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pagination, type PaginationState } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SearchInput } from '@/components/ui/SearchInput';
import { SortHeader } from './SortHeader';
import type { DlqJob, FailedJob, SortDir, SortField } from './types';

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
  const [sortBy, setSortBy] = useState<SortField>('failedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // Page-local triage: plugin-name search + a failure-category quick-chip
  // (DLQ tables only), over the rows on screen.
  const [nameQuery, setNameQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('desc');
    }
  };

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

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a[sortBy] ?? '';
      const bv = b[sortBy] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortBy, sortDir]);

  if (pagination.total === 0 && !loading) {
    return (
      <Card className="p-8 text-center">
        <Inbox className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
        <p className="text-sm text-gray-500 dark:text-gray-400">No {title.toLowerCase()} found.</p>
      </Card>
    );
  }

  const colCount = 5 + (showCategory ? 1 : 0) + (onAction ? 1 : 0);

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
                  ? 'border-blue-300 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                  : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
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
                      ? 'border-red-300 dark:border-red-600 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
                      : 'border-yellow-300 dark:border-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300'
                    : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>
      <Card className={`overflow-hidden transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading || undefined}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/50">
                <th scope="col" className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Job ID</th>
                <SortHeader label="Plugin" field="pluginName" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                {showCategory && (
                  <th scope="col" className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Category</th>
                )}
                <SortHeader label="Attempts" field="attemptsMade" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Failed At" field="failedAt" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Error" field="error" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                {onAction && (
                  <th scope="col" className="px-4 py-2.5 text-right font-medium text-gray-700 dark:text-gray-300">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                    No jobs on this page match your filter.
                  </td>
                </tr>
              )}
              {sorted.map((job) => (
                <tr key={job.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {job.id?.slice(0, 12)}
                  </td>
                  <td className="px-4 py-2.5 text-gray-900 dark:text-gray-100 font-medium">
                    {job.pluginName || '—'}
                  </td>
                  {showCategory && (
                    <td className="px-4 py-2.5">
                      <Badge color={(job as DlqJob).failureCategory === 'permanent' ? 'red' : 'yellow'}>
                        {(job as DlqJob).failureCategory || '—'}
                      </Badge>
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 tabular-nums">
                    {job.attemptsMade ?? '—'}{job.maxAttempts ? ` / ${job.maxAttempts}` : ''}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {job.failedAt ? <RelativeTime value={job.failedAt} /> : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-red-600 dark:text-red-400 text-xs max-w-xs">
                    <span className="line-clamp-2" title={job.error}>{job.error || '—'}</span>
                  </td>
                  {onAction && (
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onAction(job.id)}
                        disabled={actionPendingIds?.has(job.id)}
                        title={actionTitle}
                      >
                        {actionPendingIds?.has(job.id) ? (actionPendingLabel ?? 'Working…') : (actionLabel ?? 'Retry')}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
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

