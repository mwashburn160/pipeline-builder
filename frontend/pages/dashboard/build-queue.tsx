import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { formatError } from '@/lib/constants';
import { motion } from 'framer-motion';
import { Clock, Loader, CheckCircle2, XCircle, PauseCircle, RefreshCw, ChevronUp, ChevronDown, Inbox, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { BuildsTabs } from '@/components/ui/BuildsTabs';
import { LoadingPage } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { Pagination } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useToast } from '@/components/ui/Toast';
import type { QueueStatus } from '@/types';
import api from '@/lib/api';

const POLL_INTERVAL = 10_000;
const DEFAULT_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FailedJob {
  id: string;
  pluginName?: string;
  version?: string;
  error?: string;
  attemptsMade?: number;
  maxAttempts?: number;
  failedAt?: string;
}

interface DlqJob extends FailedJob {
  version?: string;
  failureCategory?: string;
  lastError?: string;
  createdAt?: string;
}

type SortField = 'pluginName' | 'attemptsMade' | 'failedAt' | 'error';
type SortDir = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: number | null;
  icon: LucideIcon;
  accent: string;
  delay: number;
}

function StatCard({ label, value, icon: Icon, accent, delay }: StatCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay }}
      className="card flex items-center gap-4"
    >
      <div className={`rounded-xl p-3 text-white ${accent}`}>
        <Icon className="w-6 h-6" />
      </div>
      <div>
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{label}</p>
        {value !== null ? (
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
            {value.toLocaleString()}
          </p>
        ) : (
          <div className="h-8 w-16 skeleton rounded" />
        )}
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Queue health
// ---------------------------------------------------------------------------

function queueHealth(status: QueueStatus | null): { label: string; color: string; badgeColor: 'gray' | 'red' | 'yellow' | 'blue' | 'green' } {
  if (!status) return { label: 'Loading', color: 'bg-gray-400', badgeColor: 'gray' };
  if (status.failed > 0) return { label: 'Failures Detected', color: 'bg-red-500', badgeColor: 'red' };
  if (status.waiting > 5) return { label: 'Backlogged', color: 'bg-yellow-500', badgeColor: 'yellow' };
  if (status.active > 0) return { label: 'Processing', color: 'bg-blue-500', badgeColor: 'blue' };
  return { label: 'Idle', color: 'bg-green-500', badgeColor: 'green' };
}

// ---------------------------------------------------------------------------
// Sortable column header
// ---------------------------------------------------------------------------

interface SortHeaderProps {
  label: string;
  field: SortField;
  sortBy: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}

function SortHeader({ label, field, sortBy, sortDir, onSort }: SortHeaderProps) {
  const active = sortBy === field;
  return (
    <th
      className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          sortDir === 'asc' ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 opacity-20" />
        )}
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Failed jobs table
// ---------------------------------------------------------------------------

interface FailedJobsTableProps {
  jobs: FailedJob[];
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

function FailedJobsTable({ jobs, title, showCategory, onAction, actionPendingIds, actionLabel, actionPendingLabel, actionTitle }: FailedJobsTableProps) {
  const [sortBy, setSortBy] = useState<SortField>('failedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('desc');
    }
    setPage(0);
  };

  const sorted = useMemo(() => {
    const copy = [...jobs];
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
  }, [jobs, sortBy, sortDir]);

  const paginated = useMemo(
    () => sorted.slice(page, page + pageSize),
    [sorted, page, pageSize],
  );

  if (jobs.length === 0) {
    return (
      <div className="card p-8 text-center">
        <Inbox className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
        <p className="text-sm text-gray-500 dark:text-gray-400">No {title.toLowerCase()} found.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/50">
                <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Job ID</th>
                <SortHeader label="Plugin" field="pluginName" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                {showCategory && (
                  <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Category</th>
                )}
                <SortHeader label="Attempts" field="attemptsMade" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Failed At" field="failedAt" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Error" field="error" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                {onAction && (
                  <th className="px-4 py-2.5 text-right font-medium text-gray-700 dark:text-gray-300">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {paginated.map((job) => (
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
      </div>
      {jobs.length > DEFAULT_PAGE_SIZE && (
        <div className="mt-3">
          <Pagination
            pagination={{ limit: pageSize, offset: page, total: jobs.length }}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(0); }}
            pageSizeOptions={[10, 25, 50]}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BuildQueuePage() {
  const { user, isReady, isSuperAdmin } = useAuthGuard({ requireSystemAdmin: true });
  const toast = useToast();
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [dlqJobs, setDlqJobs] = useState<DlqJob[]>([]);
  const [showFailed, setShowFailed] = useState(false);
  const [showDlq, setShowDlq] = useState(false);
  const [replayingIds, setReplayingIds] = useState<Set<string>>(new Set());
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const fetchStatus = useCallback(async () => {
    if (!mountedRef.current || document.visibilityState !== 'visible') return;
    try {
      const res = await api.getQueueStatus();
      if (!mountedRef.current) return;
      if (res.data) {
        setStatus(res.data);
        setLastUpdated(new Date());
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) setError(formatError(err, 'Failed to fetch queue status'));
    }
  }, []);

  const fetchFailed = useCallback(async () => {
    if (!mountedRef.current) return;
    try {
      const res = await api.getQueueFailed();
      if (!mountedRef.current) return;
      setFailedJobs(res.data?.jobs || []);
      setShowFailed(true);
    } catch (err) {
      if (mountedRef.current) setError(formatError(err, 'Failed to fetch failed jobs'));
    }
  }, []);

  const fetchDlq = useCallback(async () => {
    if (!mountedRef.current) return;
    try {
      const res = await api.getQueueDlq();
      if (!mountedRef.current) return;
      setDlqJobs(res.data?.jobs || []);
      setShowDlq(true);
    } catch (err) {
      if (mountedRef.current) setError(formatError(err, 'Failed to fetch DLQ jobs'));
    }
  }, []);

  // Re-enqueue a single DLQ job onto the main build queue, then refetch the
  // DLQ list so the replayed row drops out. Mirrors the triage page's replay.
  const handleReplayDlq = useCallback(async (jobId: string) => {
    if (!window.confirm('Re-enqueue this job onto the main build queue?')) return;
    setReplayingIds((prev) => new Set(prev).add(jobId));
    try {
      const res = await api.replayDlqJob(jobId);
      const newJobId = res.data?.newJobId ?? '?';
      toast.success(`Re-enqueued as job ${newJobId}`);
      await fetchDlq();
    } catch (err) {
      toast.error(formatError(err, 'Failed to replay DLQ job'));
    } finally {
      if (mountedRef.current) {
        setReplayingIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    }
  }, [toast, fetchDlq]);

  // Re-enqueue a single failed build onto the main build queue, then refetch
  // the failed list + aggregate status so the retried row drops out. Mirrors
  // the DLQ replay handler above.
  const handleRetryFailed = useCallback(async (jobId: string) => {
    if (!window.confirm('Re-enqueue this failed build onto the main build queue?')) return;
    setRetryingIds((prev) => new Set(prev).add(jobId));
    try {
      const res = await api.retryFailedJob(jobId);
      const newJobId = res.data?.newJobId ?? '?';
      toast.success(`Re-enqueued as job ${newJobId}`);
      await Promise.all([fetchFailed(), fetchStatus()]);
    } catch (err) {
      toast.error(formatError(err, 'Failed to retry build'));
    } finally {
      if (mountedRef.current) {
        setRetryingIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    }
  }, [toast, fetchFailed, fetchStatus]);

  // Purge the ENTIRE dead-letter queue — destructive, sysadmin-only. Strong
  // confirm, then refresh the aggregate status + (if open) the DLQ list.
  const handlePurgeDlq = useCallback(async () => {
    if (!window.confirm('Purge the ENTIRE dead-letter queue? This permanently deletes every DLQ entry and cannot be undone.')) return;
    setPurging(true);
    try {
      await api.purgeDlq();
      toast.success('Dead-letter queue purged');
      setDlqJobs([]);
      await fetchStatus();
    } catch (err) {
      toast.error(formatError(err, 'Failed to purge DLQ'));
    } finally {
      if (mountedRef.current) setPurging(false);
    }
  }, [toast, fetchStatus]);

  useEffect(() => {
    if (!isReady || !user) return;
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isReady, user, fetchStatus]);

  if (!isReady || !user) return <LoadingPage />;

  const health = queueHealth(status);
  const dlqTotal = status?.dlq ? (status.dlq.waiting + status.dlq.active + status.dlq.failed + status.dlq.delayed) : 0;

  const cards: Omit<StatCardProps, 'delay'>[] = [
    { label: 'Waiting', value: status?.waiting ?? null, icon: Clock, accent: 'bg-yellow-500' },
    { label: 'Active', value: status?.active ?? null, icon: Loader, accent: 'bg-blue-500' },
    { label: 'Completed', value: status?.completed ?? null, icon: CheckCircle2, accent: 'bg-green-500' },
    { label: 'Failed', value: status?.failed ?? null, icon: XCircle, accent: 'bg-red-500' },
    { label: 'Delayed', value: status?.delayed ?? null, icon: PauseCircle, accent: 'bg-gray-500' },
  ];

  return (
    <DashboardLayout
      title="Builds"
      subtitle="Queued builds and execution status"
      actions={
        <Button onClick={fetchStatus} variant="secondary">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </Button>
      }
    >
      <BuildsTabs active="queue" />
      <ErrorAlert message={error} className="mb-6" />

      {/* Health indicator */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mb-6 flex items-center gap-3"
      >
        <span className={`inline-block w-3 h-3 rounded-full ${health.color}`} />
        <Badge color={health.badgeColor}>{health.label}</Badge>
        {dlqTotal > 0 && (
          <Badge color="yellow">DLQ: {dlqTotal}</Badge>
        )}
        {lastUpdated && (
          <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Auto-refresh {POLL_INTERVAL / 1000}s &middot; {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </motion.div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {cards.map((card, i) => (
          <StatCard key={card.label} {...card} delay={0.05 + i * 0.05} />
        ))}
      </div>

      {/* Per-tier breakdown — surfaced when the backend returns
          `tiers` (sysadmin response only). Each tier has its own BullMQ
          queue so backlog can show up in one tier while the others are
          quiet; the aggregate counts above hide that. */}
      {status?.tiers && Object.keys(status.tiers).length > 0 && (
        <div className="card mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Per-tier breakdown</h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">One BullMQ queue per pricing tier</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400">
                  <th className="py-1.5 pr-4">Tier</th>
                  <th className="py-1.5 pr-4">Waiting</th>
                  <th className="py-1.5 pr-4">Active</th>
                  <th className="py-1.5 pr-4">Completed</th>
                  <th className="py-1.5 pr-4">Failed</th>
                  <th className="py-1.5 pr-4">Delayed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {Object.entries(status.tiers).map(([tier, counts]) => (
                  <tr key={tier}>
                    <td className="py-1.5 pr-4 font-mono text-xs">{tier}</td>
                    <td className="py-1.5 pr-4">{counts.waiting}</td>
                    <td className="py-1.5 pr-4">{counts.active}</td>
                    <td className="py-1.5 pr-4">{counts.completed}</td>
                    <td className={`py-1.5 pr-4 ${counts.failed > 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}>{counts.failed}</td>
                    <td className="py-1.5 pr-4">{counts.delayed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Failed jobs */}
      {status && status.failed > 0 && (
        <motion.div
          className="mt-8"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.3 }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Failed Builds
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                ({status.failed})
              </span>
            </h2>
            {!showFailed && (
              <Button onClick={fetchFailed} variant="secondary" size="sm">
                View Failed Jobs
              </Button>
            )}
          </div>
          {showFailed && (
            <FailedJobsTable
              jobs={failedJobs}
              title="failed jobs"
              onAction={handleRetryFailed}
              actionPendingIds={retryingIds}
              actionLabel="Retry"
              actionPendingLabel="Retrying…"
              actionTitle="Re-enqueue this failed build onto the main build queue"
            />
          )}
        </motion.div>
      )}

      {/* DLQ */}
      {dlqTotal > 0 && (
        <motion.div
          className="mt-8"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.35 }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
              Dead Letter Queue
              <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
                ({dlqTotal})
              </span>
            </h2>
            <div className="flex items-center gap-2">
              {!showDlq && (
                <Button onClick={fetchDlq} variant="secondary" size="sm">
                  View DLQ Jobs
                </Button>
              )}
              {isSuperAdmin && (
                <Button onClick={handlePurgeDlq} variant="danger" size="sm" disabled={purging}>
                  {purging ? 'Purging…' : 'Purge DLQ'}
                </Button>
              )}
            </div>
          </div>
          {showDlq && (
            <FailedJobsTable
              jobs={dlqJobs}
              title="DLQ jobs"
              showCategory
              onAction={handleReplayDlq}
              actionPendingIds={replayingIds}
              actionLabel="Replay"
              actionPendingLabel="Replaying…"
              actionTitle="Re-enqueue this DLQ job onto the main build queue"
            />
          )}
        </motion.div>
      )}
    </DashboardLayout>
  );
}
