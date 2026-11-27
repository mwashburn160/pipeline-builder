// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo } from 'react';
import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import { StatCard } from '@/components/ui/StatCard';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { FEATURE_METADATA } from '@/lib/feature-flags';
import { useFetch } from '@/hooks/useFetch';
import type { ApprovalWaitReport, QueueTrendPoint, QueueWaitReport } from '@/lib/api/domains/reporting-flow';
import { ExportCSVButton, ReportEmpty, SectionCardSkeleton, SectionHeading, StatCardSkeleton } from '../ReportHelpers';
import { useReportBucketing, type SharedFilters, type TabDataStatus } from '../useReportData';

interface FlowTabProps {
  filters: SharedFilters;
  /** Whether `advanced_reporting` is entitled — without it the approvals panel and the queue trend are locked and NOT requested. */
  advancedEnabled: boolean;
  onStatus: (status: TabDataStatus) => void;
}

/** A wait in seconds as the largest sensible unit (waits are often seconds, so seconds are kept). */
export function fmtWait(s: number | null): string {
  if (s === null) return '—';
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

/** The bucket label without the midnight time part. */
const periodLabel = (p: string) => p.replace(/ 00:00:00$/, '');

/** Why a panel can be empty although pipelines ran: the data is new. */
const NEW_DATA_NOTE = 'This is collected for runs after this release; earlier runs are not included.';

/** The locked state, matching the DORA upsell: same lock, same CTA, same billing highlight. */
export function FlowUpsell({ title, labels, children }: { title: string; labels: string[]; children: React.ReactNode }) {
  const meta = FEATURE_METADATA.advanced_reporting;
  return (
    <div>
      <SectionHeading>{title}</SectionHeading>
      <div className="relative overflow-hidden rounded-lg border border-default">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-4 blur-[3px] opacity-60 select-none pointer-events-none" aria-hidden="true">
          {labels.map((label) => <StatCard key={label} variant="detailed" label={label} value="—" />)}
        </div>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/70 backdrop-blur-[1px] px-6 py-8 text-center">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-info-bg text-brand">
            <Lock className="w-5 h-5" aria-hidden="true" />
          </span>
          <h4 className="text-base font-semibold text-fg">{meta.label} &mdash; {title.toLowerCase()}</h4>
          <p className="max-w-md text-sm text-fg-muted">{children} {meta.description}.</p>
          <LinkButton href="/dashboard/usage?tab=billing&highlight=advanced_reporting" size="sm" className="mt-1">
            Unlock Advanced Reporting
          </LinkButton>
        </div>
      </div>
    </div>
  );
}

/** Manual approval waits (advanced). */
export function ApprovalsPanel({ loading, data }: { loading: boolean; data: ApprovalWaitReport | null }) {
  if (loading && !data) return <><StatCardSkeleton count={4} /><SectionCardSkeleton /></>;
  const empty = !data || data.totals.approvals === 0;
  const trendRows = (data?.trend ?? []).map((t) => ({ ...t, period: periodLabel(t.period) }));
  const stageRows = (data?.slowestStages ?? []).map((s) => ({ ...s }));
  return (
    <section aria-label="Approval wait time">
      <div className="flex items-center justify-between">
        <SectionHeading>Approval wait time</SectionHeading>
        <div className="flex gap-1">
          <ExportCSVButton data={trendRows} filename="approval-waits-trend" />
          <ExportCSVButton data={stageRows} filename="approval-slowest-stages" />
        </div>
      </div>
      {empty || !data ? (
        <div>
          <ReportEmpty text="No manual approvals finished in this range" />
          <p className="mt-1 text-xs text-fg-muted text-center">{NEW_DATA_NOTE}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard variant="detailed" label="Manual approvals" value={data.totals.approvals} sub={`${data.totals.approved} approved`} />
            <StatCard variant="detailed" label="Median wait" value={fmtWait(data.totals.wait.medianSeconds)} sub={`n = ${data.totals.wait.n}`} />
            <StatCard variant="detailed" label="p90 wait" value={fmtWait(data.totals.wait.p90Seconds)} />
            <StatCard variant="detailed" label="Rejected or expired" value={data.totals.rejectedOrExpired} sub={`${data.totals.undecided} without a decision`} />
          </div>
          <Card className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Approvals per period</caption>
              <thead><tr className="text-left text-fg-muted"><th>Period</th><th>Approvals</th><th>Rejected / expired</th><th>Median wait</th><th>p90 wait</th></tr></thead>
              <tbody>
                {trendRows.map((t) => (
                  <tr key={t.period}><td>{t.period}</td><td>{t.approvals}</td><td>{t.rejectedOrExpired}</td><td>{fmtWait(t.medianSeconds)}</td><td>{fmtWait(t.p90Seconds)}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left font-medium text-fg">Slowest approval stages</caption>
              <thead><tr className="text-left text-fg-muted"><th>Pipeline</th><th>Stage</th><th>Approvals</th><th>Median</th><th>p90</th><th>Longest</th></tr></thead>
              <tbody>
                {data.slowestStages.map((s) => (
                  <tr key={`${s.pipelineId}:${s.stageName}`}>
                    <td>{s.pipelineName ?? s.pipelineId}</td><td>{s.stageName}</td><td>{s.approvals}</td>
                    <td>{fmtWait(s.medianSeconds)}</td><td>{fmtWait(s.p90Seconds)}</td><td>{fmtWait(s.maxSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-fg-muted">
              Wait is the approval action&apos;s start to its decision. AWS reports a rejection and an expiry the same way, so they are one count.
            </p>
          </Card>
        </>
      )}
    </section>
  );
}

/** Queue and provisioning time, current figures (free). */
export function QueuePanel({ loading, data }: { loading: boolean; data: QueueWaitReport | null }) {
  if (loading && !data) return <><StatCardSkeleton count={4} /><SectionCardSkeleton /></>;
  const noBuilds = !data || data.builds === 0;
  const typeRows = (data?.byComputeType ?? []).map((r) => ({ ...r }));
  const actionRows = (data?.slowestActions ?? []).map((r) => ({ ...r }));
  return (
    <section aria-label="Queue and wait time">
      <div className="flex items-center justify-between">
        <SectionHeading>Queue and wait time</SectionHeading>
        <div className="flex gap-1">
          <ExportCSVButton data={typeRows} filename="queue-time-by-compute-type" />
          <ExportCSVButton data={actionRows} filename="queue-time-longest-waits" />
        </div>
      </div>
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard variant="detailed" label="Median queue time" value={fmtWait(data.queue.medianSeconds)} sub={`p90 ${fmtWait(data.queue.p90Seconds)} · n = ${data.queue.n}`} />
          <StatCard variant="detailed" label="Median provisioning" value={fmtWait(data.provisioning.medianSeconds)} sub={`p90 ${fmtWait(data.provisioning.p90Seconds)} · n = ${data.provisioning.n}`} />
          <StatCard variant="detailed" label="Start to first stage" value={fmtWait(data.startToFirstStage.medianSeconds)} sub={`p90 ${fmtWait(data.startToFirstStage.p90Seconds)} · n = ${data.startToFirstStage.n}`} />
          <StatCard variant="detailed" label="Builds measured" value={data.builds} />
        </div>
      )}
      {noBuilds || !data ? (
        <div className="mt-4">
          <ReportEmpty text="No build queue times in this range" />
          <p className="mt-1 text-xs text-fg-muted text-center">{NEW_DATA_NOTE}</p>
        </div>
      ) : (
        <>
          <Card className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left font-medium text-fg">By compute type</caption>
              <thead><tr className="text-left text-fg-muted"><th>Compute type</th><th>Builds</th><th>Queue median</th><th>Queue p90</th><th>Provisioning median</th><th>Provisioning p90</th></tr></thead>
              <tbody>
                {data.byComputeType.map((r) => (
                  <tr key={r.computeType}>
                    <td>{r.computeType}</td><td>{r.builds}</td><td>{fmtWait(r.queueMedianSeconds)}</td><td>{fmtWait(r.queueP90Seconds)}</td>
                    <td>{fmtWait(r.provisioningMedianSeconds)}</td><td>{fmtWait(r.provisioningP90Seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left font-medium text-fg">Longest waits</caption>
              <thead><tr className="text-left text-fg-muted"><th>Pipeline</th><th>Stage</th><th>Action</th><th>Builds</th><th>Queue p90</th><th>Provisioning p90</th><th>Total p90</th></tr></thead>
              <tbody>
                {data.slowestActions.map((r) => (
                  <tr key={`${r.pipelineId}:${r.stageName}:${r.actionName}`}>
                    <td>{r.pipelineName ?? r.pipelineId}</td><td>{r.stageName ?? '—'}</td><td>{r.actionName ?? '—'}</td><td>{r.builds}</td>
                    <td>{fmtWait(r.queueP90Seconds)}</td><td>{fmtWait(r.provisioningP90Seconds)}</td><td>{fmtWait(r.totalWaitP90Seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-fg-muted">
              Queue is CodeBuild waiting for capacity; provisioning is the build environment being set up. Both are read from the build record when the action finishes.
            </p>
          </Card>
        </>
      )}
    </section>
  );
}

/** The queue-time series (advanced). */
export function QueueTrendPanel({ loading, data }: { loading: boolean; data: QueueTrendPoint[] | null }) {
  if (loading && !data) return <SectionCardSkeleton />;
  const rows = (data ?? []).map((t) => ({ ...t, period: periodLabel(t.period) }));
  const empty = rows.every((t) => t.builds === 0 && t.executions === 0);
  return (
    <section aria-label="Queue time trend">
      <div className="flex items-center justify-between">
        <SectionHeading>Queue time trend</SectionHeading>
        <ExportCSVButton data={rows} filename="queue-time-trend" />
      </div>
      {empty ? (
        <div>
          <ReportEmpty text="No queue time to trend in this range" />
          <p className="mt-1 text-xs text-fg-muted text-center">{NEW_DATA_NOTE}</p>
        </div>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Queue, provisioning and start-to-first-stage time per period</caption>
            <thead><tr className="text-left text-fg-muted"><th>Period</th><th>Builds</th><th>Queue median</th><th>Queue p90</th><th>Provisioning median</th><th>Provisioning p90</th><th>Start to first stage (median)</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.period}>
                  <td>{t.period}</td><td>{t.builds}</td><td>{fmtWait(t.queueMedianSeconds)}</td><td>{fmtWait(t.queueP90Seconds)}</td>
                  <td>{fmtWait(t.provisioningMedianSeconds)}</td><td>{fmtWait(t.provisioningP90Seconds)}</td><td>{fmtWait(t.startToFirstStageMedianSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

/**
 * Flow top-tab. The queue-time figures are free (`reports:read`); the approvals
 * panel and the queue trend need `advanced_reporting` — without it they are
 * locked and NO request for them fires. Every read carries the org's reporting
 * timezone and week start.
 */
export function FlowTab({ filters, advancedEnabled, onStatus }: FlowTabProps) {
  const bucketing = useReportBucketing();
  const params = useMemo(() => ({
    ...(filters.dateFrom ? { from: filters.dateFrom } : {}),
    ...(filters.dateTo ? { to: filters.dateTo } : {}),
    ...(filters.includeDescendants ? { includeDescendants: true } : {}),
    interval: filters.interval,
    tz: bucketing.tz,
    ...(bucketing.weekStart ? { weekStart: bucketing.weekStart } : {}),
  }), [filters.dateFrom, filters.dateTo, filters.includeDescendants, filters.interval, bucketing.tz, bucketing.weekStart]);
  const key = JSON.stringify(params);
  const ready = bucketing.ready;
  const advancedActive = advancedEnabled && ready;

  const queue = useFetch(
    (signal) => (ready ? api.getQueueWaits(params, { signal }) : Promise.resolve(null)), [ready, key],
  );
  const trend = useFetch(
    (signal) => (advancedActive ? api.getQueueWaitTrend(params, { signal }) : Promise.resolve(null)), [advancedActive, key],
  );
  const approvals = useFetch(
    (signal) => (advancedActive ? api.getApprovalWaits(params, { signal }) : Promise.resolve(null)), [advancedActive, key],
  );

  const loading = !ready || queue.loading || (advancedEnabled && (trend.loading || approvals.loading));
  const failed = queue.error ?? (advancedEnabled ? (approvals.error ?? trend.error) : null);
  const error = failed ? formatError(failed, 'Failed to load flow reports') : null;
  const { refetch: rq } = queue;
  const { refetch: rt } = trend;
  const { refetch: ra } = approvals;
  useEffect(() => {
    onStatus({ loading, error, refetch: () => { void rq(); if (advancedEnabled) { void rt(); void ra(); } } });
  }, [loading, error, rq, rt, ra, advancedEnabled, onStatus]);

  return (
    <div className="space-y-8">
      <QueuePanel loading={loading} data={queue.data} />
      {advancedEnabled ? <QueueTrendPanel loading={loading} data={trend.data} /> : (
        <FlowUpsell title="Queue time trend" labels={['Queue median', 'Queue p90', 'Provisioning median', 'Start to first stage']}>
          See how queue, provisioning and start-to-first-stage time move per period.
        </FlowUpsell>
      )}
      {advancedEnabled ? <ApprovalsPanel loading={loading} data={approvals.data} /> : (
        <FlowUpsell title="Approval wait time" labels={['Manual approvals', 'Median wait', 'p90 wait', 'Rejected or expired']}>
          See how long manual approvals hold pipelines, how many are rejected or expire, and which stages wait longest.
        </FlowUpsell>
      )}
    </div>
  );
}
