// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ExecutionCountRow } from '@/types';
import type { DoraMetrics, DoraTrendPoint } from '@/lib/api/domains/reporting';
import {
  fmtSeconds, fmtWindow, ReportEmpty, SectionHeading,
  StatCardSkeleton, SectionCardSkeleton,
  DoraCard, DoraTrendSparkline, DoraScopeControls, type DoraScope,
} from './ReportHelpers';

interface DoraReportProps {
  loading: boolean;
  dora: DoraMetrics | null;
  doraTrend: DoraTrendPoint[];
  /** All pipelines in the org (registry-sourced), for the per-pipeline picker. */
  pipelineOptions: { id: string; name: string }[];
  /** Executions in the window — fills the picker with since-deleted pipelines that
   *  ran but are no longer in the registry. */
  executions: ExecutionCountRow[];
  /** Deploy environments observed in the window, for the env datalist. */
  environmentOptions: string[];
  /** DORA scope value + callbacks (owned by the page), forwarded to DoraScopeControls. */
  doraScope: DoraScope;
}

/**
 * DORA (delivery-performance) tab: deployment frequency, change-failure rate,
 * MTTR, and lead-time proxy, plus a trend sparkline and per-pipeline / environment
 * / deploys-only scope controls. Feature-gated **at the tab level**
 * (`advanced_reporting`) — the page only mounts this when entitled, so it always
 * renders the entitled view (no inline upsell here).
 */
export function DoraReport({ loading, dora, doraTrend, pipelineOptions, executions, environmentOptions, doraScope }: DoraReportProps) {
  // Picker options: registry pipelines PLUS any pipeline that only appears in
  // execution history (e.g. since-deleted), deduped by id. Registry first so a
  // never-run pipeline is still selectable; execution-derived fills gaps.
  const doraPipelineOptions = (() => {
    const byId = new Map<string, { id: string; name: string }>();
    for (const p of pipelineOptions) byId.set(p.id, p);
    for (const e of executions) if (!byId.has(e.id)) byId.set(e.id, { id: e.id, name: e.pipeline_name || e.project });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  })();

  if (loading && dora === null) return <><StatCardSkeleton count={4} /><SectionCardSkeleton lines={5} /></>;

  return (
    <div>
      <SectionHeading>DORA Metrics</SectionHeading>
      {/* Heading + scope controls render whenever entitled — NOT gated on `dora`,
          so a scope that returns no data can still be cleared (the controls would
          otherwise unmount, trapping the user in an active filter). The metric
          cards + sparkline still gate on `dora`. */}
      <DoraScopeControls
        pipelines={doraPipelineOptions}
        environmentOptions={environmentOptions}
        {...doraScope}
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
          {/* The run-based caveat only applies when counting runs — when a
              deploy/environment scope is active the badge above already says
              "Scoped to deployments", so this text would contradict it. */}
          {dora.basis === 'run' && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              These are run-based: a &ldquo;deployment&rdquo; is a successful pipeline run, so frequency, change-failure and restore-time reflect pipeline activity rather than verified production deployments (no deploy/environment marker is captured yet). Lead time is further an approximation &mdash; median successful pipeline run time; true commit&rarr;deploy lead time requires source commit capture (roadmap).
            </p>
          )}
        </>
      ) : (
        <ReportEmpty text="No DORA data for this scope" />
      )}
    </div>
  );
}
