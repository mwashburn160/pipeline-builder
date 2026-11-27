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
import type {
  CalendarDay, DeploymentCalendarReport, ProductionDeployOutcome, RunnerReliabilityReport,
} from '@/lib/api/domains/reporting-delivery';
import { ExportCSVButton, ReportEmpty, SectionCardSkeleton, SectionHeading, StatCardSkeleton, fmtDate } from '../ReportHelpers';
import { useReportBucketing, type SharedFilters, type TabDataStatus } from '../useReportData';
import { fmtSeconds } from './SecurityTab';

interface DeliveryTabProps {
  filters: SharedFilters;
  /** Whether `advanced_reporting` is entitled. Without it the calendar is locked and NOT requested. */
  advancedEnabled: boolean;
  onStatus: (status: TabDataStatus) => void;
}

/** The bucket label without the midnight time part. */
const periodLabel = (p: string) => p.replace(/ 00:00:00$/, '');
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

const OUTCOME_LABEL: Record<ProductionDeployOutcome, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  post_deploy_failure: 'Failed after deploy',
};

/**
 * Every `YYYY-MM-DD` from the first to the last day that has a deploy, so a
 * quiet day shows as an empty cell instead of disappearing. The days are already
 * in the report timezone; the arithmetic is on calendar dates only.
 */
export function calendarDays(days: CalendarDay[]): string[] {
  if (days.length === 0) return [];
  const sorted = days.map((d) => d.day).sort();
  const out: string[] = [];
  const end = Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`);
  for (let t = Date.parse(`${sorted[0]}T00:00:00Z`); t <= end && out.length < 800; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** The locked calendar: same lock, same CTA, same billing highlight as the DORA upsell. */
export function CalendarUpsell() {
  const meta = FEATURE_METADATA.advanced_reporting;
  return (
    <div>
      <SectionHeading>Deployment calendar and change volume</SectionHeading>
      <div className="relative overflow-hidden rounded-lg border border-default">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-4 blur-[3px] opacity-60 select-none pointer-events-none" aria-hidden="true">
          {['Deployments', 'Failed at deploy', 'Commits per deploy', 'Production deploys'].map((label) => (
            <StatCard key={label} variant="detailed" label={label} value="—" />
          ))}
        </div>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/70 backdrop-blur-[1px] px-6 py-8 text-center">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-info-bg text-brand">
            <Lock className="w-5 h-5" aria-hidden="true" />
          </span>
          <h4 className="text-base font-semibold text-fg">{meta.label} &mdash; deployment calendar</h4>
          <p className="max-w-md text-sm text-fg-muted">
            See deployments per day and environment, commits per deploy, and every production deploy with its
            outcome. {meta.description}.
          </p>
          <LinkButton href="/dashboard/usage?tab=billing&highlight=advanced_reporting" size="sm" className="mt-1">
            Unlock Advanced Reporting
          </LinkButton>
        </div>
      </div>
    </div>
  );
}

/** Run latency and runner reliability (free). */
export function RunnerPanel({ loading, data }: { loading: boolean; data: RunnerReliabilityReport | null }) {
  if (loading && !data) return <><StatCardSkeleton count={4} /><SectionCardSkeleton /></>;
  if (!data) return <ReportEmpty text="No runner data yet" />;
  const { totals, trend, latency, topFailureCodes, runners } = data;
  const runnerRows = runners.map((r) => ({
    runner: r.label ?? 'Unshared runner',
    ownership: r.ownership,
    health: r.health ?? '',
    requests: r.requests,
    started: r.started,
    failed: r.failed,
    expired: r.expired,
    refused: r.refused,
    pending: r.pending,
    failureRatePct: r.failureRatePct ?? '',
    lastDeliveryAt: r.lastDeliveryAt ?? '',
  }));
  return (
    <section aria-label="Run latency and runner reliability">
      <div className="flex items-center justify-between">
        <SectionHeading>Run latency and runner reliability</SectionHeading>
        <div className="flex gap-1">
          <ExportCSVButton data={trend.map((t) => ({ ...t, period: periodLabel(t.period) }))} filename="run-requests-by-outcome" />
          <ExportCSVButton data={topFailureCodes.map((c) => ({ ...c }))} filename="runner-failure-codes" />
          <ExportCSVButton data={runnerRows} filename="runner-reliability" />
        </div>
      </div>
      {totals.requests === 0 && runners.length === 0 ? (
        <ReportEmpty text="No run requests in this range" />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard variant="detailed" label="Run requests" value={totals.requests} sub={`${totals.started} started · ${totals.pending} pending`} />
            <StatCard variant="detailed" label="Failure rate" value={pct(totals.failureRatePct)} sub={`${totals.failed} failed · ${totals.expired} expired · ${totals.refused} refused`} />
            <StatCard variant="detailed" label="Median time to start" value={fmtSeconds(latency.medianSeconds)} sub={`p90 ${fmtSeconds(latency.p90Seconds)} · n = ${latency.n}`} />
            <StatCard variant="detailed" label="Runners" value={runners.length} sub={`${runners.filter((r) => r.health === 'unreachable').length} unreachable`} />
          </div>
          <Card className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left font-medium text-fg">Run requests by outcome</caption>
              <thead><tr className="text-left text-fg-muted"><th>Period</th><th>Requests</th><th>Started</th><th>Failed</th><th>Expired</th><th>Refused</th><th>Pending</th></tr></thead>
              <tbody>
                {trend.map((t) => (
                  <tr key={t.period}><td>{periodLabel(t.period)}</td><td>{t.requests}</td><td>{t.started}</td><td>{t.failed}</td><td>{t.expired}</td><td>{t.refused}</td><td>{t.pending}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-fg-muted">
              Start and stop requests only (deploys through a runner and discovery probes are not runs). Time to start runs from the request to the
              start of the execution the runner reported.
            </p>
          </Card>
          <Card className="mt-4 overflow-x-auto">
            {topFailureCodes.length === 0 ? <ReportEmpty text="No failed run requests in this range" /> : (
              <table className="w-full text-sm">
                <caption className="text-left font-medium text-fg">Top failure codes</caption>
                <thead><tr className="text-left text-fg-muted"><th>Code</th><th>Source</th><th>Requests</th></tr></thead>
                <tbody>
                  {topFailureCodes.map((c) => <tr key={c.code}><td><code>{c.code}</code></td><td>{c.category}</td><td>{c.count}</td></tr>)}
                </tbody>
              </table>
            )}
          </Card>
          <Card className="mt-4 overflow-x-auto">
            {runners.length === 0 ? <ReportEmpty text="No runners" /> : (
              <table className="w-full text-sm">
                <caption className="text-left font-medium text-fg">Runners</caption>
                <thead><tr className="text-left text-fg-muted"><th>Runner</th><th>Owner</th><th>Health</th><th>Requests</th><th>Failure rate</th><th>Expired</th><th>Last delivery</th></tr></thead>
                <tbody>
                  {runners.map((r) => (
                    <tr key={r.runnerId}>
                      <td>{r.label ?? <span className="text-fg-muted">Unshared runner</span>}</td>
                      <td>{r.ownership === 'own' ? 'This organization' : 'Shared by parent'}</td>
                      <td className={r.health === 'unreachable' ? 'text-danger' : undefined}>{r.health ?? '—'}</td>
                      <td>{r.requests}</td>
                      <td>{pct(r.failureRatePct)}</td>
                      <td>{r.expired}</td>
                      <td>{fmtDate(r.lastDeliveryAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </section>
  );
}

/** Deployment calendar and change volume (`advanced_reporting`). */
export function CalendarPanel({ loading, data }: { loading: boolean; data: DeploymentCalendarReport | null }) {
  const days = useMemo(() => calendarDays(data?.days ?? []), [data]);
  if (loading && !data) return <><StatCardSkeleton count={4} /><SectionCardSkeleton /></>;
  if (!data) return <ReportEmpty text="No deployment data yet" />;
  const { totals, commitsPerDeploy, productionDeploys, environments } = data;
  const byKey = new Map(data.days.map((d) => [`${d.day}|${d.environment}`, d]));
  const peak = Math.max(1, ...data.days.map((d) => d.deployments));
  return (
    <section aria-label="Deployment calendar and change volume">
      <div className="flex items-center justify-between">
        <SectionHeading>Deployment calendar and change volume</SectionHeading>
        <div className="flex gap-1">
          <ExportCSVButton data={data.days.map((d) => ({ ...d }))} filename="deployments-per-day" />
          <ExportCSVButton data={productionDeploys.items.map((d) => ({ ...d }))} filename="production-deploys" />
        </div>
      </div>
      {totals.deployments === 0 ? (
        <ReportEmpty text="No deployments in this range" />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard variant="detailed" label="Deployments" value={totals.deployments} sub={`${environments.length} environment${environments.length === 1 ? '' : 's'}`} />
            <StatCard variant="detailed" label="Failed at deploy" value={totals.failed} />
            <StatCard variant="detailed" label="Commits per deploy" value={commitsPerDeploy.median ?? '—'} sub={`p90 ${commitsPerDeploy.p90 ?? '—'} · n = ${commitsPerDeploy.n}`} />
            <StatCard variant="detailed" label="Production deploys" value={productionDeploys.count} />
          </div>
          <Card className="mt-4 overflow-x-auto">
            <p className="text-sm font-medium text-fg">Deployments per day</p>
            <div className="mt-2 space-y-2">
              {environments.map((env) => (
                <div key={env} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-xs text-fg-muted" title={env}>{env}</span>
                  <div className="flex flex-wrap gap-[3px]">
                    {days.map((day) => {
                      const d = byKey.get(`${day}|${env}`);
                      const n = d?.deployments ?? 0;
                      const failed = d?.failed ?? 0;
                      return (
                        <span
                          key={day}
                          role="img"
                          aria-label={`${day} ${env}: ${n} deployment${n === 1 ? '' : 's'}, ${failed} failed`}
                          title={`${day}: ${n} deployment${n === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`}
                          className={`inline-block w-3 h-3 rounded-sm ${n > 0 ? 'bg-brand-solid' : 'bg-surface-muted'} ${failed > 0 ? 'ring-1 ring-danger' : ''}`}
                          style={n > 0 ? { opacity: 0.35 + 0.65 * (n / peak) } : undefined}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-fg-muted">
              Days in {data.tz}. Darker is more deployments; an outlined day had a failed deploy.
            </p>
          </Card>
          <Card className="mt-4 overflow-x-auto">
            {productionDeploys.items.length === 0 ? <ReportEmpty text="No production deploys in this range" /> : (
              <table className="w-full text-sm">
                <caption className="text-left font-medium text-fg">
                  Production deploys{productionDeploys.count > productionDeploys.items.length ? ` (latest ${productionDeploys.items.length} of ${productionDeploys.count})` : ''}
                </caption>
                <thead><tr className="text-left text-fg-muted"><th>Pipeline</th><th>Environment</th><th>Deployed</th><th>Commits</th><th>Outcome</th></tr></thead>
                <tbody>
                  {productionDeploys.items.map((d) => (
                    <tr key={`${d.executionId}:${d.environment}`}>
                      <td>{d.pipelineName ?? d.pipelineId ?? '—'}</td>
                      <td>{d.environment}</td>
                      <td>{fmtDate(d.deployedAt)}</td>
                      <td>{d.commitCount ?? '—'}</td>
                      <td className={d.outcome === 'succeeded' ? undefined : 'text-danger'}>{OUTCOME_LABEL[d.outcome]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </section>
  );
}

/**
 * Delivery top-tab. The runner reliability panel is free (`reports:read`); the
 * deployment calendar needs `advanced_reporting` — without it the panel is the
 * upsell and NO calendar request fires. Both reads carry the org's reporting
 * timezone and week start.
 */
export function DeliveryTab({ filters, advancedEnabled, onStatus }: DeliveryTabProps) {
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
  const calendarActive = advancedEnabled && ready;

  const runners = useFetch(
    (signal) => (ready ? api.getRunnerReliability(params, { signal }) : Promise.resolve(null)), [ready, key],
  );
  const calendar = useFetch(
    (signal) => (calendarActive ? api.getDeploymentCalendar(params, { signal }) : Promise.resolve(null)), [calendarActive, key],
  );

  const loading = !ready || runners.loading || (advancedEnabled && calendar.loading);
  const failed = runners.error ?? (advancedEnabled ? calendar.error : null);
  const error = failed ? formatError(failed, 'Failed to load delivery reports') : null;
  const { refetch: rr } = runners;
  const { refetch: rc } = calendar;
  useEffect(() => {
    onStatus({ loading, error, refetch: () => { void rr(); if (advancedEnabled) void rc(); } });
  }, [loading, error, rr, rc, advancedEnabled, onStatus]);

  return (
    <div className="space-y-8">
      <RunnerPanel loading={loading} data={runners.data} />
      {advancedEnabled ? <CalendarPanel loading={loading} data={calendar.data} /> : <CalendarUpsell />}
    </div>
  );
}
