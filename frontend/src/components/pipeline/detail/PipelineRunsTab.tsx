// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The pipeline detail page's Runs tab: the run totals and the per-pipeline execution history. */

import Link from 'next/link';
import { Ban, Play } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { RetryError } from '@/components/ui/RetryError';
import { Badge } from '@/components/ui/Badge';
import { CopyableId } from '@/components/ui/CopyableId';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { BELOW_SM, TAP_TARGET, useMediaQuery } from '@/components/ui/responsive';
import { formatDuration } from '@/lib/format';
import { failurePlugins, statusColor, type PipelineExecution } from './pipeline-detail-model';
import type { PipelineDetailData } from './usePipelineDetailData';

interface PipelineRunsTabProps {
  data: Pick<PipelineDetailData,
    'execCounts' | 'execStats' | 'executions' | 'execLoading' | 'execError' | 'loadExecutions' | 'toolchainChange' | 'toolchainMarkerRunId'>;
  canEdit: boolean;
  canceling: boolean;
  cancelTarget: string | null;
  onCancel: (executionId: string) => void;
}

export function PipelineRunsTab({ data, canEdit, canceling, cancelTarget, onCancel }: PipelineRunsTabProps) {
  const { execCounts, execStats, executions, execLoading, execError, loadExecutions, toolchainChange, toolchainMarkerRunId } = data;
  // On a phone the history is a stack of run cards: the table's seven columns
  // put a run's failure and its Cancel a long sideways scroll away.
  const compact = useMediaQuery(BELOW_SM);

  const execColumns: Column<PipelineExecution>[] = [
    {
      id: 'status',
      header: 'Status',
      render: (ex) => (
        <>
          <Badge color={statusColor(ex.status)}>{ex.status}</Badge>
          {toolchainChange && ex.execution_id === toolchainMarkerRunId && (
            <span className="mt-1 block font-mono text-2xs text-fg-muted" data-testid={`toolchain-marker-${ex.execution_id}`}>
              toolchain {toolchainChange.from} → {toolchainChange.to}
            </span>
          )}
        </>
      ),
    },
    { id: 'started', header: 'Started', render: (ex) => (ex.started_at ? <RelativeTime value={ex.started_at} /> : <span className="text-fg-subtle">—</span>) },
    { id: 'duration', header: 'Duration', cellClassName: 'font-mono text-xs', render: (ex) => formatDuration(ex.duration_ms) },
    {
      id: 'failing',
      header: 'Failing step',
      render: (ex) => (ex.failing_stage || ex.failing_action
        ? <span className="text-danger">{ex.failing_stage || ex.failing_action}</span>
        : <span className="text-fg-subtle">—</span>),
    },
    {
      id: 'failure',
      header: 'Failure',
      render: (ex) => {
        const f = ex.status === 'failed' ? ex.failure : null;
        if (!f || (!f.code && !f.message)) return <span className="text-fg-subtle">—</span>;
        const plugins = failurePlugins(f);
        return (
          <span className="block max-w-md text-xs" data-testid={`execution-failure-${ex.execution_id}`}>
            {f.code && <code className="mr-1 font-mono text-danger">{f.code}</code>}
            {f.message && <span className="text-fg-muted">{f.message}</span>}
            {plugins.length > 0 && <span className="block font-mono text-fg-subtle">{plugins.join(', ')}</span>}
          </span>
        );
      },
    },
    { id: 'execution', header: 'Execution', render: (ex) => <CopyableId value={ex.execution_id} size="sm" /> },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (ex) => (ex.status === 'in-progress' ? (
        <Button
          variant="secondary"
          onClick={() => onCancel(ex.execution_id)}
          disabled={!canEdit || (canceling && cancelTarget === ex.execution_id)}
          className={`inline-flex items-center gap-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed max-sm:w-full ${TAP_TARGET}`}
          title={canEdit ? 'Cancel this execution' : 'Read-only (public catalog entry)'}
        >
          {canceling && cancelTarget === ex.execution_id ? <LoadingSpinner size="sm" /> : <Ban className="w-3.5 h-3.5" />}
          Cancel
        </Button>
      ) : (
        <span className="text-fg-subtle">—</span>
      )),
    },
  ];
  const cell = (id: string, ex: PipelineExecution, index: number) => execColumns.find((c) => c.id === id)!.render(ex, index);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Recent runs card — derived from the org-wide execution-count
          aggregate. */}
      <Card className="min-w-0">
        <h3 className="text-base font-semibold text-fg mb-3">Recent runs</h3>
        {execStats ? (
          <dl className="text-sm space-y-1.5">
            <div className="flex justify-between">
              <dt className="text-fg-muted">Total executions</dt>
              <dd className="font-mono text-xs">{execStats.total}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-fg-muted">Succeeded</dt>
              <dd className="font-mono text-xs text-success">{execStats.succeeded}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-fg-muted">Failed</dt>
              <dd className="font-mono text-xs text-danger">{execStats.failed}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-fg-muted">Canceled</dt>
              <dd className="font-mono text-xs">{execStats.canceled}</dd>
            </div>
            {execStats.last_execution && (
              <div className="flex justify-between">
                <dt className="text-fg-muted">Last run</dt>
                <dd><RelativeTime value={execStats.last_execution} /></dd>
              </div>
            )}
            {executions && executions.length > 0 && (
              <div className="pt-2 mt-1 border-t border-default space-y-1.5">
                {executions.slice(0, 3).map((ex) => (
                  <div key={ex.execution_id} className="flex items-center justify-between">
                    <Badge color={statusColor(ex.status)}>{ex.status}</Badge>
                    <span className="text-xs text-fg-subtle">
                      {ex.started_at ? <RelativeTime value={ex.started_at} /> : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="pt-2">
              <Link href="/dashboard/executions" className="action-link text-xs">
                View all executions →
              </Link>
            </div>
          </dl>
        ) : execCounts.error ? (
          // A failed org-wide read is not "no runs": say so, with a retry.
          <RetryError message="Run totals could not be loaded" onRetry={execCounts.refetch} />
        ) : execCounts.loading ? (
          <div className="flex items-center gap-2 text-sm text-fg-muted"><LoadingSpinner size="sm" label={null} /> Loading runs…</div>
        ) : (
          <p className="text-sm text-fg-muted">No recorded runs yet.</p>
        )}
      </Card>

      {/* Executions card — per-pipeline run history from the reporting
          service, plus the AWS CodePipeline trigger / cancel write path.
          "Run pipeline" calls StartPipelineExecution; per-row "Cancel"
          (in-progress only) calls StopPipelineExecution. Both refetch the
          list after a short delay so the change surfaces. */}
      <Card className="lg:col-span-2 min-w-0">
        <h3 className="text-base font-semibold text-fg mb-3">Executions</h3>
        {execLoading && !executions && <LoadingSpinner />}
        {execError && <RetryError message={execError} onRetry={loadExecutions} />}
        {!execLoading && !execError && executions && executions.length === 0 && (
          <p className="text-sm text-fg-muted">No executions recorded yet.</p>
        )}
        {!execError && executions && executions.length > 0 && compact && (
          <ul className="-mx-5 divide-y divide-default border-t border-default" aria-label="Executions">
            {executions.map((ex, i) => (
              <li key={ex.execution_id} aria-label={`Run ${ex.execution_id}`} className="px-5 py-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">{cell('status', ex, i)}</div>
                  <span className="shrink-0 text-xs text-fg-subtle">{cell('started', ex, i)}</span>
                </div>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-fg-muted">Duration</dt>
                  <dd className="font-mono">{cell('duration', ex, i)}</dd>
                  {(ex.failing_stage || ex.failing_action) && (
                    <>
                      <dt className="text-fg-muted">Failing step</dt>
                      <dd className="break-words">{cell('failing', ex, i)}</dd>
                    </>
                  )}
                </dl>
                {ex.status === 'failed' && ex.failure && (ex.failure.code || ex.failure.message) && (
                  <div className="break-words">{cell('failure', ex, i)}</div>
                )}
                <div className="text-xs">{cell('execution', ex, i)}</div>
                {ex.status === 'in-progress' && cell('actions', ex, i)}
              </li>
            ))}
          </ul>
        )}
        {!execError && executions && executions.length > 0 && !compact && (
          <div className="overflow-x-auto">
            <DataTable
              data={executions}
              columns={execColumns}
              isLoading={false}
              animated={false}
              getRowKey={(ex) => ex.execution_id}
              emptyState={{ icon: Play, title: 'No executions', description: 'No executions recorded yet.' }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
