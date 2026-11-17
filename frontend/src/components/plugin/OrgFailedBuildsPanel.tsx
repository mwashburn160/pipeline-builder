// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import { FailedJobsTable } from '@/components/build-queue/FailedJobsTable';
import { toServerPage } from '@/components/build-queue/server-page';
import type { DlqJob, FailedJob } from '@/components/build-queue/types';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { useToast } from '@/components/ui/Toast';
import { useServerPagination } from '@/hooks/useServerPagination';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';

type Target = { kind: 'retry' | 'replay'; jobId: string };

/**
 * Why a retry / replay was refused, in the org's terms. A 404 is a job that is
 * no longer there (retried by someone else, aged out) — the server answers the
 * same for another org's job, so the list is simply stale.
 */
function actionError(err: unknown, kind: Target['kind']): string {
  if (err instanceof ApiError && err.statusCode === 404) {
    return 'That build is no longer in the queue — the list has been refreshed.';
  }
  return formatError(err, kind === 'retry' ? 'Failed to retry build' : 'Failed to replay build');
}

/**
 * The ORG's own failed plugin builds, with Retry (failed set) and Replay
 * (dead-letter queue) — the tenant half of the build queue.
 *
 * `GET /plugins/queue/failed` + `/dlq` and their retry / replay routes all
 * require `plugins:write`, and the server scopes a caller that is not a
 * system-org queue operator to its own org's jobs (another org's job answers
 * 404), so the parent renders this only for `plugins:write` holders. The
 * platform-wide view (tier depth, DLQ purge) stays on the operator-only Build
 * queue page.
 */
export function OrgFailedBuildsPanel({ seesEveryOrg = false }: {
  /** A system-org queue operator: the server returns every org's jobs. */
  seesEveryOrg?: boolean;
}) {
  const toast = useToast();
  const [target, setTarget] = useState<Target | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const failed = useServerPagination<FailedJob, Record<string, never>>(
    async ({ offset, limit, signal }) => {
      const res = await api.getQueueFailed({ offset, limit }, { signal });
      return toServerPage<FailedJob>(res.data?.jobs, res.data?.pagination, offset, limit);
    },
    {},
  );
  const dlq = useServerPagination<DlqJob, Record<string, never>>(
    async ({ offset, limit, signal }) => {
      const res = await api.getQueueDlq({ offset, limit }, { signal });
      // The DLQ row carries its reason as `lastError`; the table reads `error`.
      const jobs = res.data?.jobs.map((j) => ({ ...j, error: j.error ?? j.lastError }));
      return toServerPage<DlqJob>(jobs, res.data?.pagination, offset, limit);
    },
    {},
  );
  const { refetch: refetchFailed } = failed;
  const { refetch: refetchDlq } = dlq;

  const run = useCallback(async (t: Target) => {
    setPendingIds((prev) => new Set(prev).add(t.jobId));
    try {
      const res = t.kind === 'retry'
        // Name the tier queue: the same job id can exist in several tiers.
        ? await api.retryFailedJob(t.jobId, failed.items?.find((j) => j.id === t.jobId)?.tier)
        : await api.replayDlqJob(t.jobId);
      toast.success(`Re-enqueued as job ${res.data?.newJobId ?? '?'}`);
    } catch (err) {
      toast.error(actionError(err, t.kind));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(t.jobId);
        return next;
      });
      // Either way the row's state changed (gone, or already gone).
      if (t.kind === 'retry') refetchFailed();
      else refetchDlq();
    }
  }, [toast, refetchFailed, refetchDlq, failed.items]);

  const scope = seesEveryOrg ? 'every organization\'s' : 'your organization\'s';

  return (
    <div className="space-y-6" data-testid="org-failed-builds">
      <SectionCard
        icon={XCircle}
        title="Failed builds"
        description={`Plugin builds of ${scope} that failed. Retry re-runs one from its retained build context; a build whose context was released, or that the vulnerability gate refused, offers an upload instead.`}
      >
        {failed.error
          ? <RetryError message={formatError(failed.error, 'Failed to fetch failed builds')} onRetry={refetchFailed} />
          : (
            <FailedJobsTable
              jobs={failed.items}
              pagination={failed.pagination}
              onPageChange={failed.setOffset}
              loading={failed.loading}
              title="failed builds"
              onAction={(jobId) => setTarget({ kind: 'retry', jobId })}
              actionPendingIds={pendingIds}
              actionLabel="Retry"
              actionPendingLabel="Retrying…"
              actionTitle="Re-enqueue this failed build"
            />
          )}
      </SectionCard>

      <SectionCard
        icon={AlertTriangle}
        title="Dead-lettered builds"
        description={`Builds of ${scope} that exhausted their retries. Replay runs one again with fresh retry counters.`}
      >
        {dlq.error
          ? <RetryError message={formatError(dlq.error, 'Failed to fetch dead-lettered builds')} onRetry={refetchDlq} />
          : (
            <FailedJobsTable
              jobs={dlq.items}
              pagination={dlq.pagination}
              onPageChange={dlq.setOffset}
              loading={dlq.loading}
              title="dead-lettered builds"
              showCategory
              onAction={(jobId) => setTarget({ kind: 'replay', jobId })}
              actionPendingIds={pendingIds}
              actionLabel="Replay"
              actionPendingLabel="Replaying…"
              actionTitle="Re-enqueue this dead-lettered build"
            />
          )}
      </SectionCard>

      {target && (
        <ConfirmDialog
          title={target.kind === 'retry' ? 'Retry failed build?' : 'Replay dead-lettered build?'}
          confirmLabel={target.kind === 'retry' ? 'Retry build' : 'Replay'}
          loading={pendingIds.has(target.jobId)}
          onConfirm={async () => { await run(target); setTarget(null); }}
          onCancel={() => setTarget(null)}
        >
          <p>
            Job <span className="font-mono">{target.jobId.slice(0, 12)}</span> will be re-enqueued as a new build. It
            takes a slot of your plugin build quota like any other build.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
