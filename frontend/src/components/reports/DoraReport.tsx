// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import type { ExecutionCountRow } from '@/types';
import type { DoraEnvMetrics, DoraMetrics, DoraTrendPoint, DeploymentRow , LeadTimeGap } from '@/lib/api/domains/reporting';
import { fmtDate, ReportEmpty, SectionHeading, StatCardSkeleton, SectionCardSkeleton } from './ReportHelpers';
import {
  fmtWindow, DoraCard, DoraCountingNote, DoraTrendSparkline, DoraScopeControls, DeltaChip,
  metricDelta, useDoraComparison, type DoraScope,
} from './DoraParts';
import { LEAD_TIME_GAP_COPY, leadTimeGapTooltip } from './report-copy';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatDurationSeconds } from '@/lib/format';

/** Billing deep-link that rings the DORA-History pack on the add-ons grid. */
const RETENTION_PACK_HIGHLIGHT = '/dashboard/billing?highlight=dora_history_pack';

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
  /** Recent deploy executions for the scoped pipeline (the mark failed/restored list). */
  deployments: DeploymentRow[];
  /** Whether a single pipeline is scoped (the deploy list is per-pipeline). */
  deployPipelineSelected: boolean;
  /** Environment a marked outcome is attributed to (applied env filter or `production`). */
  markEnvironment: string;
  /** Whether the viewer may mark deployment outcomes (`pipelines:write`). */
  canMark: boolean;
  /** Read-only impersonation — mark actions render disabled with the reason (the outcome POST would 403). */
  markReadOnly?: boolean;
  /** Record a deploy outcome, then refresh. */
  onMarkOutcome: (executionId: string, outcome: 'failed' | 'restored') => Promise<void>;
  /** DORA scope value + callbacks (owned by the page), forwarded to DoraScopeControls. */
  doraScope: DoraScope;
  /** The requested `from` bound (`YYYY-MM-DD`, or ''), to detect a retention
   *  truncation when the backend floors `dora.window.from` later than requested. */
  requestedFrom?: string;
  /** The page's "Include child teams" scope, so the period-over-period comparison
   *  reads the same org set as `dora` (advanced_reporting; see useDoraComparison). */
  includeDescendants?: boolean;
}

/**
 * True when the backend floored the window start later than the user asked for —
 * i.e. `dora.window.from` (the effective start) is a later calendar day than the
 * requested `from`. Signals the report was clipped by the DORA retention horizon.
 */
function isTruncated(requestedFrom: string | undefined, windowFrom: string): boolean {
  if (!requestedFrom) return false;
  const req = new Date(`${requestedFrom}T00:00:00`);
  const eff = new Date(windowFrom);
  if (Number.isNaN(req.getTime()) || Number.isNaN(eff.getTime())) return false;
  // Compare at day granularity (a few hours of clock skew isn't a truncation).
  return eff.getTime() - req.getTime() > 86_400_000;
}

/**
 * The short "why unknown" line under an unknown lead time: the most common
 * stored reason (the tooltip lists them all with their fixes). Null when the
 * backend recorded none.
 */
function unknownLeadSummary(reasons: Partial<Record<LeadTimeGap, number>> | undefined): string | null {
  const top = (Object.entries(reasons ?? {}) as Array<[LeadTimeGap, number]>)
    .filter(([k, n]) => n > 0 && k in LEAD_TIME_GAP_COPY)
    .sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const others = Object.values(reasons ?? {}).filter((n) => (n ?? 0) > 0).length - 1;
  return `Why: ${LEAD_TIME_GAP_COPY[top[0]].label}${others > 0 ? ` (+${others} more)` : ''}`;
}

/** Whole days spanned by the effective window (for the "last N days" banner). */
function windowDays(window: { from: string; to: string }): number {
  const from = new Date(window.from);
  const to = new Date(window.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

/**
 * DORA (delivery-performance) tab: per-environment deployment frequency
 * (headline `production`), measured lead time (or "unknown"), a change-failure
 * breakdown (deploy-time + post-deploy of attempts), median time to restore, and a coverage note —
 * plus a trend sparkline, a mark failed/restored deploy list, and per-pipeline /
 * environment / deploys-only scope controls. Feature-gated **at the tab level**
 * (`advanced_reporting`) — the page only mounts this when entitled, so it always
 * renders the entitled view (no inline upsell here).
 */
export function DoraReport({
  loading, dora, doraTrend, pipelineOptions, executions, environmentOptions,
  deployments, deployPipelineSelected, markEnvironment, canMark, markReadOnly = false, onMarkOutcome, doraScope,
  requestedFrom, includeDescendants = false,
}: DoraReportProps) {
  // The previous equal-length window, for the delta chips (null when not
  // entitled, not comparable, or still loading — the cards then show none).
  const previous = useDoraComparison(dora, includeDescendants);
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
      {/* Heading + a compact coverage stat on one row, with the scope controls
          directly below — NOT gated on `dora`, so a scope that returns no data can
          still be cleared (the controls would otherwise unmount, trapping the user
          in an active filter). The metric cards + sparkline still gate on `dora`. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <SectionHeading>DORA Metrics</SectionHeading>
        {dora && (
          <span className="text-xs text-fg-muted tabular-nums" title="Registered pipelines vs. those that actually deployed in this window">
            {dora.coverage.registered} registered {dora.coverage.registered === 1 ? 'pipeline' : 'pipelines'} &middot; {dora.coverage.deploying} deploying
            {dora.coverage.withoutDeploys > 0 ? <> &middot; {dora.coverage.withoutDeploys} idle</> : null}
          </span>
        )}
      </div>
      <DoraScopeControls
        pipelines={doraPipelineOptions}
        environmentOptions={environmentOptions}
        {...doraScope}
      />
      {dora ? (() => {
        // Headline env: the one named by `dora.headline` (e.g. production),
        // falling back to the first (sorted headline-first) when absent.
        const headlineEnv =
          dora.environments.find((e) => e.environment === dora.headline) ?? dora.environments[0] ?? null;
        const deltas = headlineEnv && previous ? doraDeltas(headlineEnv, dora, previous) : null;
        return (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 -mt-1 mb-3 text-xs text-fg-subtle">
            {fmtWindow(dora.window) && <span className="tabular-nums">{fmtWindow(dora.window)}</span>}
            <span className="inline-flex items-center rounded bg-surface-muted px-1.5 py-0.5">
              Deployment-scoped{dora.filters.environment ? ` · ${dora.filters.environment}` : ''}
            </span>
          </div>
          {/* Retention truncation: the backend floors the window start at the
              DORA retention horizon, so a wider request silently returns less.
              Surface it + a deep-link to extend history via a pack. */}
          {isTruncated(requestedFrom, dora.window.from) && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-strong" role="status">
              <span>
                Showing the last <strong>{windowDays(dora.window)} days</strong> — limited by your DORA retention.
              </span>
              <Link href={RETENTION_PACK_HIGHLIGHT} className="underline hover:no-underline font-medium shrink-0">
                Extend history
              </Link>
            </div>
          )}
          {headlineEnv ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <DoraCard
                label={<>Deployment frequency <span className="text-fg-subtle">({headlineEnv.environment})</span></>}
                value={String(headlineEnv.deploymentFrequency.deployments)}
                sub={<>{headlineEnv.deploymentFrequency.deployments === 1 ? 'deploy' : 'deploys'} &middot; {headlineEnv.deploymentFrequency.perDay.toFixed(2)}/day</>}
                level={headlineEnv.deploymentFrequency.level}
                n={headlineEnv.deploymentFrequency.n}
                delta={deltas?.deploymentFrequency}
                tooltip={`Successful ${headlineEnv.environment} deploy-stage executions in the window. Per-environment breakdown below.`}
              />
              <DoraCard
                label="Lead time"
                value={headlineEnv.leadTime.medianSeconds == null ? 'unknown' : formatDurationSeconds(headlineEnv.leadTime.medianSeconds)}
                sub={
                  headlineEnv.leadTime.medianSeconds == null
                    ? <>{unknownLeadSummary(headlineEnv.leadTime.unknownReasons) ?? 'No resolved commit times'}</>
                    : <>median commit&rarr;deploy &middot; {headlineEnv.leadTime.deployments} deploys</>
                }
                level={headlineEnv.leadTime.level}
                n={headlineEnv.leadTime.n}
                delta={deltas?.leadTime}
                tooltip={
                  (headlineEnv.leadTime.medianSeconds == null ? leadTimeGapTooltip(headlineEnv.leadTime.unknownReasons) : null)
                  ?? 'Measured commit→deploy time (from resolved commit timestamps). "unknown" when commit times couldn’t be resolved for the in-window deploys.'
                }
              />
              <DoraCard
                label="Change failure rate"
                value={`${headlineEnv.changeFailureRate.rate}%`}
                sub={
                  <>
                    <span>{`${headlineEnv.changeFailureRate.deployTimeFailures + headlineEnv.changeFailureRate.postDeployFailures}/${headlineEnv.changeFailureRate.attempts} deploys failed`}</span>
                    <span className="block text-fg-subtle">
                      {`${headlineEnv.changeFailureRate.deployTimeFailures} deploy-time · ${headlineEnv.changeFailureRate.postDeployFailures} post-deploy`}
                    </span>
                    {/* CFR source hint: post-deploy failures are sourced
                        automatically from the incident webhook, or manually from the
                        mark-failed control below. Deep-link to configure the webhook. */}
                    <span className="block text-2xs text-fg-subtle">
                      post-deploy source: {headlineEnv.changeFailureRate.postDeployFailures > 0 ? 'auto — incidents / manual' : 'manual'}
                      {' · '}
                      <Link href="/dashboard/settings/incident-reporting" className="underline hover:no-underline">
                        configure incidents
                      </Link>
                    </span>
                  </>
                }
                level={headlineEnv.changeFailureRate.level}
                n={headlineEnv.changeFailureRate.n}
                delta={deltas?.changeFailureRate}
                tooltip="(deploy-time failures + post-deploy failures) ÷ deploy attempts. Post-deploy failures are sourced automatically from the incident webhook (PagerDuty/Datadog/Alertmanager) or manually from the mark-failed control below (deduped by deploy)."
              />
              <DoraCard
                label={<>Median time to restore <span className="text-fg-subtle">({headlineEnv.environment})</span></>}
                value={formatDurationSeconds(dora.meanTimeToRestore.medianSeconds)}
                sub={`${dora.meanTimeToRestore.restored}/${dora.meanTimeToRestore.incidents} incidents restored`}
                level={dora.meanTimeToRestore.level}
                n={dora.meanTimeToRestore.n}
                delta={deltas?.timeToRestore}
                tooltip={`Median (not mean) time from a ${headlineEnv.environment} failure — an incident opening, or a deploy marked failed — to its restoration. "—" means no recovery was measured in this window.`}
              />
            </div>
          ) : (
            <ReportEmpty text="No deploy-attributed environments in this window." />
          )}
          {headlineEnv && <DoraCountingNote />}

          {/* Per-environment breakdown: deploy frequency + CFR per environment.
              Each pill is a button that pivots the headline to that environment
              (commits it as the env filter → the cards above recompute for it). */}
          {dora.environments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {dora.environments.map((env) => {
                const active = headlineEnv?.environment === env.environment;
                return (
                  <button
                    key={env.environment}
                    type="button"
                    onClick={() => doraScope.onEnvironmentCommit(env.environment)}
                    aria-pressed={active}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs tabular-nums transition-colors ${
                      active
                        ? 'border-info-border bg-info-bg text-info'
                        : 'border-default text-fg-muted hover:bg-surface-muted'
                    }`}
                    title={`Pivot the headline to ${env.environment} — ${env.deploymentFrequency.deployments} deploy${env.deploymentFrequency.deployments === 1 ? '' : 's'} · ${env.deploymentFrequency.perDay.toFixed(2)}/day · CFR ${env.changeFailureRate.rate}%`}
                  >
                    <span className={`font-medium ${active ? '' : 'text-fg'}`}>{env.environment}</span>
                    {env.deploymentFrequency.deployments} &middot; {env.deploymentFrequency.perDay.toFixed(2)}/day &middot; {env.changeFailureRate.rate}% CFR
                  </button>
                );
              })}
            </div>
          )}

          {doraTrend.length > 0 && (
            <div className="mt-4">
              <DoraTrendSparkline points={doraTrend} />
            </div>
          )}

          {/* ── Deploy list: mark failed / restored ── */}
          <DeploymentList
            deployments={deployments}
            pipelineSelected={deployPipelineSelected}
            markEnvironment={markEnvironment}
            canMark={canMark}
            readOnly={markReadOnly}
            onMarkOutcome={onMarkOutcome}
          />
        </>
        );
      })() : (
        <ReportEmpty text="No DORA data for this scope" />
      )}
    </div>
  );
}

// ─── Period-over-period chips ───────────────────────────

/** A signed duration, e.g. "+2h 5m" / "−40s". */
function signedDuration(seconds: number): string {
  return `${seconds > 0 ? '+' : '−'}${formatDurationSeconds(Math.abs(seconds))}`;
}

/**
 * The four card chips against the previous window, for the SAME environment the
 * cards show (an environment absent from the previous window had no deploys
 * there: zero deployments, and no rate or lead time to compare). Deployment
 * frequency compares deploy counts — the windows are the same length.
 */
export function doraDeltas(env: DoraEnvMetrics, dora: DoraMetrics, previous: DoraMetrics) {
  const prev = previous.environments.find((e) => e.environment === env.environment) ?? null;
  const chip = (d: ReturnType<typeof metricDelta>, text: (v: number) => string, previousText: string) =>
    (d ? <DeltaChip delta={d} text={text(d.delta)} previousText={previousText} /> : undefined);
  const prevDeploys = prev?.deploymentFrequency.deployments ?? 0;
  const prevLead = prev?.leadTime.medianSeconds ?? null;
  const prevRestore = previous.meanTimeToRestore.medianSeconds;
  return {
    deploymentFrequency: chip(
      metricDelta(env.deploymentFrequency.deployments, prevDeploys, 'higher', 0),
      (v) => `${v > 0 ? '+' : '−'}${Math.abs(v)}`,
      `${prevDeploys} deploys`,
    ),
    changeFailureRate: chip(
      metricDelta(env.changeFailureRate.attempts > 0 ? env.changeFailureRate.rate : null, prev && prev.changeFailureRate.attempts > 0 ? prev.changeFailureRate.rate : null, 'lower'),
      (v) => `${v > 0 ? '+' : '−'}${Math.abs(v)} pts`,
      prev ? `${prev.changeFailureRate.rate}%` : 'no deploys',
    ),
    leadTime: chip(
      metricDelta(env.leadTime.medianSeconds, prevLead, 'lower', 0),
      signedDuration,
      prevLead == null ? 'unknown' : formatDurationSeconds(prevLead),
    ),
    timeToRestore: chip(
      metricDelta(dora.meanTimeToRestore.medianSeconds, prevRestore, 'lower', 0),
      signedDuration,
      prevRestore == null ? 'none measured' : formatDurationSeconds(prevRestore),
    ),
  };
}

// ─── Deploy list (mark failed / restored) ───────────────

interface DeploymentListProps {
  deployments: DeploymentRow[];
  pipelineSelected: boolean;
  markEnvironment: string;
  canMark: boolean;
  readOnly: boolean;
  onMarkOutcome: (executionId: string, outcome: 'failed' | 'restored') => Promise<void>;
}

/**
 * Recent deploy executions for the scoped pipeline with mark-failed / mark-restored
 * row actions. Post-deploy outcomes feed the change-failure rate + median time to restore. The
 * outcome endpoint keys on an executionId, so the list only shows once a single
 * pipeline is scoped.
 */
function DeploymentList({ deployments, pipelineSelected, markEnvironment, canMark, readOnly, onMarkOutcome }: DeploymentListProps) {
  // Per-row in-flight guard so a double-click can't fire two outcome writes.
  const [pending, setPending] = useState<string | null>(null);

  const mark = async (executionId: string, outcome: 'failed' | 'restored') => {
    setPending(executionId);
    try {
      await onMarkOutcome(executionId, outcome);
    } finally {
      setPending(null);
    }
  };

  return (
    <Card className="mt-4">
      <div className="flex items-center justify-between mb-3">
        <SectionHeading>Deployments</SectionHeading>
        {canMark && pipelineSelected && (
          <span className="text-xs text-fg-subtle">
            Outcomes attributed to <span className="font-medium text-fg-muted">{markEnvironment}</span>
          </span>
        )}
      </div>
      {!pipelineSelected ? (
        <ReportEmpty text="Select a pipeline to list its deployments and mark failed/restored outcomes." />
      ) : deployments.length === 0 ? (
        <ReportEmpty text="No deployments for this pipeline in the window." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-subtle border-b border-default">
                <th scope="col" className="py-2 pr-3 font-medium">Execution</th>
                <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                <th scope="col" className="py-2 pr-3 font-medium">When</th>
                {canMark && <th scope="col" className="py-2 pr-3 font-medium text-right">Outcome</th>}
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.execution_id} className="border-b border-default last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs text-fg-muted truncate max-w-[14rem]" title={d.execution_id}>
                    {d.execution_id}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium ${
                      d.status === 'Succeeded'
                        ? 'bg-success-bg text-success'
                        : d.status === 'Failed'
                          ? 'bg-danger-bg text-danger'
                          : 'bg-surface-muted text-fg-muted'
                    }`}>
                      {d.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-fg-muted tabular-nums">{fmtDate(d.ended_at || d.started_at)}</td>
                  {canMark && (
                    <td className="py-2 pr-3">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="xs"
                          readOnly={readOnly}
                          disabled={pending === d.execution_id}
                          onClick={() => mark(d.execution_id, 'failed')}
                          title='Mark this deployment as failed in production (post-deploy failure)'
                        >
                          Mark failed
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          readOnly={readOnly}
                          disabled={pending === d.execution_id}
                          onClick={() => mark(d.execution_id, 'restored')}
                          title='Mark this deployment as restored (recovery — feeds median time to restore)'
                        >
                          Mark restored
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
