import { useEffect, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { motion } from 'framer-motion';
import { Clock, Loader, CheckCircle2, XCircle, PauseCircle, RefreshCw, Inbox, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { usePolling } from '@/hooks/usePolling';
import { useFetch } from '@/hooks/useFetch';
import { useServerPagination } from '@/hooks/useServerPagination';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { StatCard } from '@/components/ui/StatCard';
import { BuildsTabs } from '@/components/ui/BuildsTabs';
import { LoadingPage } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { RetryError } from '@/components/ui/RetryError';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useToast } from '@/components/ui/Toast';
import type { QueueStatus } from '@/types';
import api from '@/lib/api';
import { formatTime } from '@/lib/format';
import { FailedJobsTable } from '@/components/build-queue/FailedJobsTable';
import type { DlqJob, FailedJob } from '@/components/build-queue/types';
import type { QueuePagination } from '@/lib/api/domains/plugins';

const POLL_INTERVAL = 10_000;

/** Rows per server page in the failed-build and DLQ tables. */
const JOBS_PAGE_SIZE = 25;

/**
 * Normalize a queue page for `useServerPagination`. The server's `total` is
 * exact for system admins (this page's audience); if it is ever absent, fall
 * back to "what we've seen, plus one more page when the server says there is
 * one" so the pager still offers Next.
 */
function toServerPage<T>(jobs: T[] | undefined, p: QueuePagination | undefined, offset: number, limit: number) {
  const items = jobs ?? [];
  const total = p?.total ?? offset + items.length + (p?.hasMore ? 1 : 0);
  return { items, pagination: { offset: p?.offset ?? offset, limit: p?.limit ?? limit, total } };
}

interface TierRow { tier: string; waiting: number; active: number; completed: number; failed: number; delayed: number }

// Muted-zero rendering: a 0 is greyed out so any non-zero count pops — failed in
// red, delayed in amber. Turns a field of identical black zeros into scannable
// signal (the "muted-common / loud-exception" pattern used across the tables).
function tierCount(n: number, tone?: 'red' | 'amber') {
  const cls = n === 0
    ? 'text-fg-subtle'
    : tone === 'red' ? 'text-danger font-medium'
      : tone === 'amber' ? 'text-warning font-medium'
        : 'text-fg';
  return <span className={`tabular-nums ${cls}`}>{n}</span>;
}

const TIER_COLUMNS: Column<TierRow>[] = [
  { id: 'tier', header: 'Tier', cellClassName: 'font-mono text-xs', render: (r) => r.tier },
  { id: 'waiting', header: 'Waiting', render: (r) => tierCount(r.waiting) },
  { id: 'active', header: 'Active', render: (r) => tierCount(r.active) },
  { id: 'completed', header: 'Completed', render: (r) => tierCount(r.completed) },
  { id: 'failed', header: 'Failed', render: (r) => tierCount(r.failed, 'red') },
  { id: 'delayed', header: 'Delayed', render: (r) => tierCount(r.delayed, 'amber') },
];

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

/** One build-queue stat tile's data (rendered via the shared `ui/StatCard` nav
 *  variant). `accentClass` colors the icon tile; `value` is null while loading. */
interface QueueStatCard {
  label: string;
  value: number | null;
  icon: LucideIcon;
  accentClass: string;
  /** When set, the card becomes a link (e.g. Failed → the triage tab). */
  href?: string;
}

// ---------------------------------------------------------------------------
// Queue health
// ---------------------------------------------------------------------------

function queueHealth(status: QueueStatus | null): { label: string; color: string; badgeColor: 'gray' | 'red' | 'yellow' | 'blue' | 'green' } {
  if (!status) return { label: 'Loading', color: 'bg-gray-400', badgeColor: 'gray' };
  if (status.failed > 0) return { label: 'Failures detected', color: 'bg-red-500', badgeColor: 'red' };
  if (status.waiting > 5) return { label: 'Backlogged', color: 'bg-yellow-500', badgeColor: 'yellow' };
  if (status.active > 0) return { label: 'Processing', color: 'bg-blue-500', badgeColor: 'blue' };
  return { label: 'Idle', color: 'bg-green-500', badgeColor: 'green' };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BuildQueuePage() {
  // Sysadmin-only — declared once in page-access.ts (the nav entry's gate).
  const { accessDenied, user, isReady, isSuperAdmin } = useAuthGuard();
  const toast = useToast();
  const [showFailed, setShowFailed] = useState(false);
  // When every tier is idle the per-tier table is a wall of zeros; collapse it
  // to one line, with an opt-in expand.
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showDlq, setShowDlq] = useState(false);
  const [replayingIds, setReplayingIds] = useState<Set<string>>(new Set());
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState(false);
  // Confirmation targets — queue actions route through a confirm modal instead
  // of a bare window.confirm (ConfirmDialog for per-row replay/retry, StepUpModal
  // for the fleet-wide DLQ purge).
  const [replayTarget, setReplayTarget] = useState<string | null>(null);
  const [retryTarget, setRetryTarget] = useState<string | null>(null);
  const [pendingPurge, setPendingPurge] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const enabled = isReady && !!user;
  const statusQ = useFetch<QueueStatus | null>(
    async () => (enabled ? (await api.getQueueStatus()).data ?? null : null),
    [enabled],
  );
  const status = statusQ.data;
  const fetchStatus = statusQ.refetch;
  useEffect(() => { if (status) setLastUpdated(new Date()); }, [status]);

  // The two job tables are server-paged and only read once the operator opens
  // them (`visible` is part of the filter key, so opening resets to page 1).
  const failed = useServerPagination<FailedJob, { visible: boolean }>(
    async ({ offset, limit, filters, signal }) => {
      if (!filters.visible) return toServerPage<FailedJob>([], undefined, 0, limit);
      const res = await api.getQueueFailed({ offset, limit }, { signal });
      return toServerPage(res.data?.jobs, res.data?.pagination, offset, limit);
    },
    { visible: showFailed },
    JOBS_PAGE_SIZE,
  );
  const dlq = useServerPagination<DlqJob, { visible: boolean }>(
    async ({ offset, limit, filters, signal }) => {
      if (!filters.visible) return toServerPage<DlqJob>([], undefined, 0, limit);
      const res = await api.getQueueDlq({ offset, limit }, { signal });
      return toServerPage(res.data?.jobs, res.data?.pagination, offset, limit);
    },
    { visible: showDlq },
    JOBS_PAGE_SIZE,
  );
  const { refetch: refetchFailed } = failed;
  const { refetch: refetchDlq } = dlq;

  // Re-enqueue a single DLQ job onto the main build queue, then refetch the
  // DLQ list so the replayed row drops out. Mirrors the triage page's replay.
  const handleReplayDlq = useCallback(async (jobId: string) => {
    setReplayingIds((prev) => new Set(prev).add(jobId));
    try {
      const res = await api.replayDlqJob(jobId);
      const newJobId = res.data?.newJobId ?? '?';
      toast.success(`Re-enqueued as job ${newJobId}`);
      refetchDlq();
    } catch (err) {
      toast.error(formatError(err, 'Failed to replay DLQ job'));
    } finally {
      setReplayingIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  }, [toast, refetchDlq]);

  // Re-enqueue a single failed build onto the main build queue, then refetch
  // the failed list + aggregate status so the retried row drops out. Mirrors
  // the DLQ replay handler above.
  const handleRetryFailed = useCallback(async (jobId: string) => {
    setRetryingIds((prev) => new Set(prev).add(jobId));
    try {
      const res = await api.retryFailedJob(jobId);
      const newJobId = res.data?.newJobId ?? '?';
      toast.success(`Re-enqueued as job ${newJobId}`);
      refetchFailed();
      void fetchStatus();
    } catch (err) {
      toast.error(formatError(err, 'Failed to retry build'));
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  }, [toast, refetchFailed, fetchStatus]);

  // Purge the ENTIRE dead-letter queue — destructive, sysadmin-only. Strong
  // confirm, then refresh the aggregate status + (if open) the DLQ list.
  const handlePurgeDlq = useCallback(async () => {
    setPurging(true);
    try {
      await api.purgeDlq();
      toast.success('Dead-letter queue purged');
      refetchDlq();
      void fetchStatus();
    } catch (err) {
      toast.error(formatError(err, 'Failed to purge DLQ'));
    } finally {
      setPurging(false);
    }
  }, [toast, fetchStatus, refetchDlq]);

  // Poll the aggregate status while the tab is visible (usePolling pauses when
  // hidden and refreshes on return). The first read is useFetch's own.
  usePolling(fetchStatus, POLL_INTERVAL, { enabled, immediate: false });

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  const health = queueHealth(status);
  const dlqTotal = status?.dlq ? (status.dlq.waiting + status.dlq.active + status.dlq.failed + status.dlq.delayed) : 0;

  // Idle = no actionable work in any tier (completed is cumulative history, so
  // it doesn't count toward "busy").
  const tiersIdle = status?.tiers
    ? Object.values(status.tiers).every((c) => ((c.waiting ?? 0) + (c.active ?? 0) + (c.failed ?? 0) + (c.delayed ?? 0)) === 0)
    : false;

  const cards: QueueStatCard[] = [
    { label: 'Waiting', value: status?.waiting ?? null, icon: Clock, accentClass: 'bg-yellow-500' },
    { label: 'Active', value: status?.active ?? null, icon: Loader, accentClass: 'bg-blue-500' },
    { label: 'Completed', value: status?.completed ?? null, icon: CheckCircle2, accentClass: 'bg-green-500' },
    { label: 'Failed', value: status?.failed ?? null, icon: XCircle, accentClass: 'bg-red-500', href: '/dashboard/triage' },
    { label: 'Delayed', value: status?.delayed ?? null, icon: PauseCircle, accentClass: 'bg-gray-500' },
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
      {statusQ.error && (
        <RetryError message={formatError(statusQ.error, 'Failed to fetch queue status')} onRetry={fetchStatus} className="mb-6" />
      )}

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
          <span className="text-xs text-fg-subtle ml-auto flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Auto-refresh {POLL_INTERVAL / 1000}s &middot; {formatTime(lastUpdated)}
          </span>
        )}
      </motion.div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {cards.map((card) => (
          <StatCard
            key={card.label}
            variant="nav"
            icon={card.icon}
            label={card.label}
            accentClass={card.accentClass}
            href={card.href}
            value={card.value == null ? null : card.value.toLocaleString()}
          />
        ))}
      </div>

      {/* Per-tier breakdown — surfaced when the backend returns
          `tiers` (sysadmin response only). Each tier has its own BullMQ
          queue so backlog can show up in one tier while the others are
          quiet; the aggregate counts above hide that. */}
      {status?.tiers && Object.keys(status.tiers).length > 0 && (
        <Card className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg">Per-tier breakdown</h3>
            <span className="text-xs text-fg-muted">One BullMQ queue per pricing tier</span>
          </div>
          {tiersIdle && !showBreakdown ? (
            <div className="flex items-center justify-between gap-3 text-sm text-fg-muted">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-success" />
                All {Object.keys(status.tiers).length} tiers idle — no waiting, active, failed, or delayed builds.
              </span>
              <button
                type="button"
                onClick={() => setShowBreakdown(true)}
                className="shrink-0 text-xs font-medium text-brand hover:underline"
              >
                Show full breakdown
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <DataTable
                data={Object.entries(status.tiers).map(([tier, counts]) => ({ tier, ...counts }))}
                columns={TIER_COLUMNS}
                isLoading={false}
                animated={false}
                getRowKey={(r) => r.tier}
                emptyState={{ icon: Inbox, title: 'No tiers', description: 'No per-tier breakdown available.' }}
              />
            </div>
          )}
        </Card>
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
            <h2 className="text-lg font-semibold text-fg">
              Failed Builds
              <span className="ml-2 text-sm font-normal text-fg-muted">
                ({status.failed})
              </span>
            </h2>
            {!showFailed && (
              <Button onClick={() => setShowFailed(true)} variant="secondary" size="sm">
                View Failed Jobs
              </Button>
            )}
          </div>
          {failed.error && (
            <RetryError message={formatError(failed.error, 'Failed to fetch failed jobs')} onRetry={refetchFailed} className="mb-4" />
          )}
          {showFailed && (
            <FailedJobsTable
              jobs={failed.items}
              pagination={failed.pagination}
              onPageChange={failed.setOffset}
              loading={failed.loading}
              title="failed jobs"
              onAction={(id) => setRetryTarget(id)}
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
            <h2 className="text-lg font-semibold text-fg flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-warning" />
              Dead Letter Queue
              <span className="text-sm font-normal text-fg-muted">
                ({dlqTotal})
              </span>
            </h2>
            <div className="flex items-center gap-2">
              {!showDlq && (
                <Button onClick={() => setShowDlq(true)} variant="secondary" size="sm">
                  View DLQ Jobs
                </Button>
              )}
              {isSuperAdmin && (
                <Button onClick={() => setPendingPurge(true)} variant="danger" size="sm" disabled={purging}>
                  {purging ? 'Purging…' : 'Purge DLQ'}
                </Button>
              )}
            </div>
          </div>
          {dlq.error && (
            <RetryError message={formatError(dlq.error, 'Failed to fetch DLQ jobs')} onRetry={refetchDlq} className="mb-4" />
          )}
          {showDlq && (
            <FailedJobsTable
              jobs={dlq.items}
              pagination={dlq.pagination}
              onPageChange={dlq.setOffset}
              loading={dlq.loading}
              title="DLQ jobs"
              showCategory
              onAction={(id) => setReplayTarget(id)}
              actionPendingIds={replayingIds}
              actionLabel="Replay"
              actionPendingLabel="Replaying…"
              actionTitle="Re-enqueue this DLQ job onto the main build queue"
            />
          )}
        </motion.div>
      )}

      {/* Replay confirmation (per DLQ row) */}
      {replayTarget && (
        <ConfirmDialog
          title="Replay DLQ job?"
          confirmLabel="Replay"
          loading={replayingIds.has(replayTarget)}
          onConfirm={async () => { await handleReplayDlq(replayTarget); setReplayTarget(null); }}
          onCancel={() => setReplayTarget(null)}
        >
          <p>
            Job <span className="font-mono">{replayTarget.slice(0, 12)}</span> will be re-enqueued onto the main build
            queue and run again.
          </p>
        </ConfirmDialog>
      )}

      {/* Retry confirmation (per failed-build row) */}
      {retryTarget && (
        <ConfirmDialog
          title="Retry failed build?"
          confirmLabel="Retry build"
          loading={retryingIds.has(retryTarget)}
          onConfirm={async () => { await handleRetryFailed(retryTarget); setRetryTarget(null); }}
          onCancel={() => setRetryTarget(null)}
        >
          <p>
            Job <span className="font-mono">{retryTarget.slice(0, 12)}</span> will be re-enqueued as a new build.
          </p>
        </ConfirmDialog>
      )}

      {/* Full-DLQ purge — fleet-wide + irreversible, so it re-verifies the
          operator's password (step-up) before firing. */}
      {pendingPurge && (
        <StepUpModal
          action="Purge the ENTIRE dead-letter queue — this permanently deletes every DLQ entry and cannot be undone"
          onConfirmed={async () => { await handlePurgeDlq(); }}
          onClose={() => setPendingPurge(false)}
        />
      )}
    </DashboardLayout>
  );
}
