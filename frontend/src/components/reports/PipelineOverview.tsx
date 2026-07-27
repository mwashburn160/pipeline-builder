import { GitBranch } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ExecutionCountRow } from '@/types';
import type { DoraMetrics, DoraTrendPoint } from '@/lib/api/domains/reporting';
import {
  fmtDate, fmtSeconds, fmtWindow, ReportEmpty, SectionHeading,
  StatCardSkeleton, SectionCardSkeleton,
  DoraCard, DoraTrendSparkline, DoraUpsell, DoraScopeControls,
} from './ReportHelpers';
import { StatCard } from './StatCard';
import type { TimelineEntry } from './types';

interface PipelineOverviewProps {
  loading: boolean;
  executions: ExecutionCountRow[];
  timeline: TimelineEntry[];
  dora: DoraMetrics | null;
  doraTrend: DoraTrendPoint[];
  doraEnabled: boolean;
  // DORA scope state + wiring (owned by the page).
  doraPipelineId: string;
  doraEnvironment: string;
  doraDeploysOnly: boolean;
  onDoraPipelineChange: (v: string) => void;
  onDoraEnvironmentChange: (v: string) => void;
  onDoraEnvironmentCommit: (v: string) => void;
  onDoraDeploysOnlyChange: (v: boolean) => void;
}

/** Pipelines → Overview tab: summary stats, DORA section, execution + success-rate timelines. */
export function PipelineOverview({
  loading, executions, timeline, dora, doraTrend, doraEnabled,
  doraPipelineId, doraEnvironment, doraDeploysOnly,
  onDoraPipelineChange, onDoraEnvironmentChange, onDoraEnvironmentCommit, onDoraDeploysOnlyChange,
}: PipelineOverviewProps) {
  const totalExec = executions.reduce((s, p) => s + p.total, 0);
  const totalPass = executions.reduce((s, p) => s + p.succeeded, 0);
  const totalFail = executions.reduce((s, p) => s + p.failed, 0);
  const successRate = totalExec > 0 ? ((totalPass / totalExec) * 100).toFixed(1) : '—';
  const hasOverviewData = executions.length > 0 || timeline.length > 0 || dora !== null;

  if (loading && !hasOverviewData) return <><StatCardSkeleton count={4} /><SectionCardSkeleton lines={5} /></>;
  if (!loading && !hasOverviewData) return <EmptyState icon={GitBranch} title="No pipeline data yet" description="Run some pipelines to see execution analytics here." illustration="pipelines" />;
  if (!hasOverviewData) return null;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Executions', value: totalExec },
          { label: 'Success Rate', value: successRate === '—' ? '—' : `${successRate}%` },
          { label: 'Failures', value: totalFail },
          { label: 'Pipelines', value: executions.length },
        ].map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} />
        ))}
      </div>
      {!doraEnabled && <DoraUpsell />}
      {/* Render the heading + scope controls whenever entitled — NOT gated on
          `dora`, so a scope that returns no data can still be cleared (the
          controls would otherwise unmount, trapping the user in an active
          filter). The metric cards + sparkline still gate on `dora`. */}
      {doraEnabled && (
        <div>
          <SectionHeading>DORA Metrics</SectionHeading>
          <DoraScopeControls
            pipelines={executions.map((p) => ({ id: p.id, name: p.pipeline_name || p.project }))}
            pipelineId={doraPipelineId}
            environment={doraEnvironment}
            deploysOnly={doraDeploysOnly}
            onPipelineChange={onDoraPipelineChange}
            onEnvironmentChange={onDoraEnvironmentChange}
            onEnvironmentCommit={onDoraEnvironmentCommit}
            onDeploysOnlyChange={onDoraDeploysOnlyChange}
          />
          {dora ? (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 -mt-1 mb-3 text-xs text-gray-400 dark:text-gray-500">
                {fmtWindow(dora.window) && <span className="tabular-nums">{fmtWindow(dora.window)}</span>}
                {dora.basis === 'run' ? (
                  <span className="inline-flex items-center rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5">Counting pipeline runs</span>
                ) : (
                  <span className="inline-flex items-center rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5">
                    Scoped to deployments{dora.filters.environment ? ` · ${dora.filters.environment}` : ''}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <DoraCard
                  label="Deployment Frequency"
                  value={String(dora.deploymentFrequency.deployments)}
                  sub={<>{dora.deploymentFrequency.deployments === 1 ? 'deploy' : 'deploys'} &middot; {dora.deploymentFrequency.perDay.toFixed(2)}/day</>}
                  level={dora.deploymentFrequency.level}
                />
                <DoraCard
                  label="Change Failure Rate"
                  value={`${dora.changeFailureRate.pct}%`}
                  sub={`${dora.changeFailureRate.failed}/${dora.changeFailureRate.total} deploys failed`}
                  level={dora.changeFailureRate.level}
                />
                <DoraCard
                  label="Time to Restore (MTTR)"
                  value={fmtSeconds(dora.meanTimeToRestore.avgSeconds)}
                  sub={`${dora.meanTimeToRestore.restored}/${dora.meanTimeToRestore.failures} incidents restored`}
                  level={dora.meanTimeToRestore.level}
                  tooltip={'Average time from a failure incident to the recovering run. "—" means no failures occurred in this window.'}
                />
                <DoraCard
                  label={<>Lead time &asymp; <span className="text-gray-300 dark:text-gray-600">(pipeline run time)</span></>}
                  value={fmtSeconds(dora.leadTime.medianSeconds)}
                  sub={<>Approx &middot; median run time</>}
                  level={dora.leadTime.level}
                  tooltip="Proxy: median successful pipeline run time — true commit→deploy lead time requires source commit capture (roadmap)."
                />
              </div>
              {doraTrend.length > 0 && (
                <div className="mt-4">
                  <DoraTrendSparkline points={doraTrend} />
                </div>
              )}
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                These are run-based: a &ldquo;deployment&rdquo; is a successful pipeline run, so frequency, change-failure and restore-time reflect pipeline activity rather than verified production deployments (no deploy/environment marker is captured yet). Lead time is further an approximation &mdash; median successful pipeline run time; true commit&rarr;deploy lead time requires source commit capture (roadmap).
              </p>
            </>
          ) : (
            <ReportEmpty text="No DORA data for this scope" />
          )}
        </div>
      )}
      <div className="card">
        <SectionHeading>Execution Timeline</SectionHeading>
        {timeline.length > 0 ? (
          <div className="space-y-1.5">
            {timeline.map((entry) => {
              const total = entry.succeeded + entry.failed + entry.canceled;
              const sPct = total > 0 ? (entry.succeeded / total) * 100 : 0;
              const fPct = total > 0 ? (entry.failed / total) * 100 : 0;
              const cPct = total > 0 ? (entry.canceled / total) * 100 : 0;
              return (
                <div key={entry.period} className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 dark:text-gray-500 w-16 shrink-0 tabular-nums">{fmtDate(entry.period)}</span>
                  <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden flex">
                    {sPct > 0 && <div className="h-full bg-green-500" style={{ width: `${sPct}%` }} />}
                    {fPct > 0 && <div className="h-full bg-red-500" style={{ width: `${fPct}%` }} />}
                    {cPct > 0 && <div className="h-full bg-yellow-400" style={{ width: `${cPct}%` }} />}
                  </div>
                  <span className="text-xs text-gray-400 dark:text-gray-500 w-12 text-right tabular-nums">{total}</span>
                </div>
              );
            })}
            <div className="flex items-center gap-2 mt-2"><Badge color="green">Pass</Badge><Badge color="red">Fail</Badge><Badge color="yellow">Canceled</Badge></div>
          </div>
        ) : <ReportEmpty text="No execution data for this period" />}
      </div>
      {timeline.length > 0 && (
        <div className="card">
          <SectionHeading>Success Rate Trend</SectionHeading>
          <div className="space-y-1.5">
            {timeline.map((entry) => {
              const pct = Math.round(entry.success_pct);
              const color = pct >= 90 ? 'bg-green-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-red-500';
              return (
                <div key={entry.period} className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 dark:text-gray-500 w-16 shrink-0 tabular-nums">{fmtDate(entry.period)}</span>
                  <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden"><div className={`h-full ${color} rounded`} style={{ width: `${pct}%` }} /></div>
                  <span className={`text-xs tabular-nums w-10 text-right font-medium ${pct >= 90 ? 'text-green-600 dark:text-green-400' : pct >= 70 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
