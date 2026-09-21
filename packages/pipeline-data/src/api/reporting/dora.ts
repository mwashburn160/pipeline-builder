// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DORA metrics: the four headline measures, their per-environment breakdown,
 * the trend series, and per-pipeline build health.
 *
 * By far the largest domain in the reporting service (~490 lines of query +
 * shaping against six row shapes), which is why it lives in its own module.
 * ReportingService delegates to these; the banding thresholds they apply are in
 * ./dora-scoring.ts, deliberately separate so they can be tested without a DB.
 */

import { sql } from 'drizzle-orm';
import {
  HEADLINE_ENV, DORA_INCIDENT_WINDOW_HOURS, resolveIncidentWindowHours,
  doraLevelForFrequency, doraLevelForChangeFailure, doraLevelForRestore, doraLevelForLeadTime,
  round, median,
} from './dora-scoring.js';
import { orgScope, runReport } from './query-scope.js';
import { assertReportInterval, terminalStatusRollup } from './sql-helpers.js';
import type {
  DoraOptions, DoraMetrics, DoraEnvMetrics, DoraTrendPoint, BuildHealth, BuildHealthStage,
  DeployRow, OutcomeRow, MttrPairRow, IncidentRow, CoverageRow,
} from './types.js';
import { schema } from '../../database/drizzle-schema.js';
import { withTenantTx } from '../../database/tenancy.js';
import { drizzleRows } from '../crud-service.js';

/**
 * 1.9 DORA metrics over a [from,to] deploy-completion window, org-scoped +
 * rollup-aware. DEPLOY-BASIS ONLY — every metric derives from real deploy-stage
 * executions (`event_type='STAGE'` with a non-null `environment`, set by the
 * forwarder for the stages a user declared in `pb.deploys`). No run-based
 * fallback: a pipeline with no deploy stage produces no DORA data.
 *
 * Four scoped SQL scans run inside one tx (each org-gated by `p.org_id ${pred}`
 * / `o.org_id ${pred}` so a rollup passes the org→team subtree and a foreign
 * org's rows never enter): (1) terminal deploy rows PER (execution, env) — one
 * "deployment" = one execution reaching an env (D1) — → DF / deploy-time CFR /
 * measured lead time (lead time joins the execution's earliest commit, D2);
 * the scan also reaches back `windowHours` before `from` so incidents opened
 * near the window start can correlate to a just-prior deploy; (2) `deployment_outcomes`
 * in-window → post-deploy CFR component; (3) production restored/failed
 * outcomes joined to their deploy → MTTR; (4) registry vs deploying → coverage.
 * The cross-source medians (lead time, MTTR) are computed in JS from clamped
 * (≥0) deltas.
 *
 * @param opts.pipelineId    restrict to one pipeline (per-pipeline DORA)
 * @param opts.environment   restrict to one deploy environment
 */
export async function getDoraMetrics(
  orgId: string,
  from: string,
  to: string,
  orgIds?: string[],
  opts: DoraOptions = {},
): Promise<DoraMetrics> {
  const { pred, multi } = orgScope(orgId, orgIds);
  const { pipelineId, environment } = opts;
  const pipelineClause = pipelineId ? sql`AND e.pipeline_id = ${pipelineId}` : sql``;
  const pipelineClauseR = pipelineId ? sql`AND r.pipeline_id = ${pipelineId}` : sql``;
  // Post-deploy outcomes carry no pipeline id, only the execution that
  // produced them, so a per-pipeline view has to scope them THROUGH the
  // execution. Without it the outcome and MTTR scans read every pipeline in the
  // org: another pipeline's `failed` marker counted against this one's change
  // failure rate (ten clean deploys could drop from elite to high) and its
  // recoveries fed this one's MTTR.
  const outcomePipelineClause = pipelineId
    ? sql`AND o.execution_id IN (SELECT pe.execution_id FROM ${schema.pipelineEvent} pe WHERE pe.pipeline_id = ${pipelineId})`
    : sql``;
  // `envClause` is the STRICT filter (coverage, and the output). The deploy and
  // incident SCANS use the widened `scanEnvClause`/`scanIncidentEnvClause`
  // instead, which always admit production: MTTR is production-only and
  // documented as independent of the environment filter, but incident-sourced
  // MTTR correlates each production incident against production DEPLOY rows.
  // Filtering both scans to `?environment=staging` removed every production
  // incident and every production deploy, so incident recovery silently dropped
  // out of MTTR the moment anyone looked at a non-production environment.
  // `shapeDora` narrows the reported environments back to the requested one.
  const envClause = environment ? sql`AND e.environment = ${environment}` : sql``;
  const scanEnvClause = environment ? sql`AND e.environment IN (${environment}, ${HEADLINE_ENV})` : sql``;
  const outcomeEnvClause = environment ? sql`AND o.environment = ${environment}` : sql``;
  const scanIncidentEnvClause = environment ? sql`AND i.environment IN (${environment}, ${HEADLINE_ENV})` : sql``;

  // Effective incident-correlation window (per-org override or the global
  // default). Computed here (not just in shapeDora) because the deploy scan
  // needs it for BOTH the correlation look-back lower bound AND the cache key.
  const effectiveWindowHours = resolveIncidentWindowHours(opts.incidentWindowHours);
  // Correlation look-back: incidents opened just inside `from` can attribute to
  // a deploy that completed up to `windowHours` BEFORE `from` (mirrors the
  // LATERAL look-back in listIncidents). Widen the deploy scan's lower bound to
  // `from − windowHours`; DF/CFR/lead still count only the in-`from`..`to`
  // subset (flagged by `in_window`), while correlation sees the wider set.
  const fromMs = Date.parse(from);
  const lookbackFrom = Number.isFinite(fromMs)
    ? new Date(fromMs - effectiveWindowHours * 3600 * 1000).toISOString()
    : from;

  // (1) Terminal deploy rows: PER-EXECUTION (D1), one row per (environment,
  // execution) — every deploy STAGE targeting that env within the execution is
  // rolled up to a terminal status (FAILED wins, then SUCCEEDED). A single
  // execution with two deploy stages to the same env is ONE deployment, not two.
  // completed_at = the deploy's completion (MAX over its stages). `commit_ts`
  // (D2) is the execution's EARLIEST commit time across ALL its events (commit
  // enrichment rides the PIPELINE/source event where environment IS NULL, never
  // the deploy STAGE row), joined by execution_id. `in_window` marks whether the
  // deploy completed inside [from,to] (vs. a look-back-only row kept solely for
  // incident correlation). execution_id is projected so post-deploy failures
  // (manual outcomes + correlated incidents) can dedup against their deploy.
  const deploySql = sql`
      WITH deploy_stages AS (
        SELECT
          e.environment AS environment,
          e.execution_id AS execution_id,
          ${terminalStatusRollup} AS status,
          MAX(e.completed_at) AS completed_at
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.environment IS NOT NULL
          ${pipelineClause} ${scanEnvClause}
          AND e.completed_at >= ${lookbackFrom}::timestamptz AND e.completed_at <= ${to}::timestamptz
        GROUP BY e.environment, e.execution_id
      ),
      exec_commits AS (
        SELECT c.execution_id AS execution_id, MIN(c.commit_timestamp) AS commit_ts
        FROM ${schema.pipelineEvent} c
        JOIN ${schema.pipeline} p ON p.id = c.pipeline_id
        WHERE p.org_id ${pred} AND c.commit_timestamp IS NOT NULL
          AND c.execution_id IN (SELECT execution_id FROM deploy_stages)
        GROUP BY c.execution_id
      )
      SELECT
        ds.environment AS environment,
        ds.execution_id AS execution_id,
        ds.status AS status,
        ds.completed_at::text AS completed_at,
        (ds.completed_at >= ${from}::timestamptz) AS in_window,
        ec.commit_ts::text AS commit_ts
      FROM deploy_stages ds
      LEFT JOIN exec_commits ec ON ec.execution_id = ds.execution_id`;

  // (2) Post-deploy outcome markers in-window (per env). Post-deploy failures
  // (outcome='failed') add to the CFR numerator without changing attempts.
  // execution_id lets the CFR dedup a manual failure against an incident that
  // correlates to the same deploy (no double-count).
  const outcomeSql = sql`
      SELECT o.environment AS environment, o.outcome AS outcome, o.execution_id AS execution_id
      FROM ${schema.deploymentOutcome} o
      WHERE o.org_id ${pred} ${outcomeEnvClause} ${outcomePipelineClause}
        AND o.at >= ${from}::timestamptz AND o.at <= ${to}::timestamptz`;

  // (3) MTTR — PRODUCTION-ONLY, independent of the env filter. Every production
  // outcome in-window; for a 'restored' one, correlate to its deploy's
  // completion via execution_id to measure restored.at − deployed.completed_at.
  // execution_id is projected so an incident-sourced recovery for the same
  // deploy takes precedence over the manual restored gap.
  const mttrSql = sql`
      SELECT
        o.outcome AS outcome,
        o.execution_id AS execution_id,
        o.at::text AS restored_at,
        (SELECT MAX(d.completed_at) FROM ${schema.pipelineEvent} d
           JOIN ${schema.pipeline} p2 ON p2.id = d.pipeline_id
           WHERE p2.org_id ${pred} AND d.execution_id = o.execution_id
             AND d.event_type = 'STAGE' AND d.environment = ${HEADLINE_ENV})::text AS deployed_at
      FROM ${schema.deploymentOutcome} o
      WHERE o.org_id ${pred} AND o.environment = ${HEADLINE_ENV} ${outcomePipelineClause}
        AND o.at >= ${from}::timestamptz AND o.at <= ${to}::timestamptz`;

  // (5) Incidents opened in-window (per env). Correlated in JS to the most
  // recent successful deploy → automated post-deploy failure (CFR) + real
  // recovery time (resolved_at − opened_at) for MTTR (production).
  const incidentSql = sql`
      SELECT i.environment AS environment, i.opened_at::text AS opened_at, i.resolved_at::text AS resolved_at
      FROM ${schema.incident} i
      WHERE i.org_id ${pred} ${scanIncidentEnvClause}
        AND i.opened_at >= ${from}::timestamptz AND i.opened_at <= ${to}::timestamptz`;

  // (4) Coverage: registered pipelines vs those that actually deployed in-window.
  const coverageSql = sql`
      SELECT
        (SELECT COUNT(*)::int FROM ${schema.pipelineRegistry} r
           WHERE r.org_id ${pred} ${pipelineClauseR}) AS registered,
        (SELECT COUNT(DISTINCT e.pipeline_id)::int FROM ${schema.pipelineEvent} e
           JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
           WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.environment IS NOT NULL
             ${pipelineClause} ${envClause}
             AND e.completed_at >= ${from}::timestamptz AND e.completed_at <= ${to}::timestamptz) AS deploying`;

  const exec = () => withTenantTx(async (tx) => {
    // Scan order is load-bearing for the generated-SQL tests: 0=deploy,
    // 1=outcomes, 2=mttr, 3=coverage, 4=incidents (appended last so the
    // earlier indices stay stable).
    const deployRows = drizzleRows<DeployRow>((await tx.execute(deploySql)).rows);
    const outcomeRows = drizzleRows<OutcomeRow>((await tx.execute(outcomeSql)).rows);
    const mttrRows = drizzleRows<MttrPairRow & { outcome: string }>((await tx.execute(mttrSql)).rows);
    const coverageRow = drizzleRows<CoverageRow>((await tx.execute(coverageSql)).rows)[0];
    const incidentRows = drizzleRows<IncidentRow>((await tx.execute(incidentSql)).rows);
    return shapeDora(deployRows, outcomeRows, mttrRows, coverageRow, incidentRows, from, to, {
      pipelineId, environment,
    }, effectiveWindowHours);
  });
  // Cache key MUST include the effective incident window: the scorecard reads
  // /dora with the org's default window while an explicit /dora call may pass an
  // override — different windows yield different CFR/MTTR, so they must not
  // collide on the same key.
  const key = `${orgId}:dora:${from}:${to}:${pipelineId ?? ''}:${environment ?? ''}:${effectiveWindowHours}`;
  return runReport(key, multi, exec);
}

/**
 * Shape the raw DORA scan rows into the public {@link DoraMetrics}. Buckets the
 * terminal deploy rows by environment (DF / deploy-time CFR / measured lead),
 * folds in the post-deploy failure counts (manual outcomes + webhook-ingested
 * incidents, deduped by deploy execution), computes production MTTR from both
 * sources (incident `resolved_at − opened_at` taking precedence over the manual
 * `restored − deployed`), and reconciles coverage — all cross-source medians
 * over deltas clamped ≥0.
 *
 * Phase 5 incident correlation: each incident is attributed to the most recent
 * SUCCESSFUL deploy to its environment with `completed_at ≤ opened_at` within
 * {@link DORA_INCIDENT_WINDOW_HOURS}. That deploy is a post-deploy failure; an
 * uncorrelated incident (no eligible deploy) contributes nothing.
 */
function shapeDora(
  deployRows: DeployRow[],
  outcomeRows: OutcomeRow[],
  mttrRows: Array<MttrPairRow & { outcome: string }>,
  coverageRow: CoverageRow | undefined,
  incidentRows: IncidentRow[],
  from: string,
  to: string,
  filters: { pipelineId?: string; environment?: string },
  windowHours: number = DORA_INCIDENT_WINDOW_HOURS,
): DoraMetrics {
  // Window length in days (floored at 1 so a sub-day window yields the count as
  // the rate, never /0 or an extrapolation). Guard unparseable dates → 1 day.
  const spanDays = (Date.parse(to) - Date.parse(from)) / 86400000;
  const days = Number.isFinite(spanDays) ? Math.max(spanDays, 1) : 1;
  // Window end instant for MTTR right-censoring (a resolution after `to` is
  // unobserved). +Infinity when `to` is unparseable ⇒ no censoring (fail-open).
  const toParsed = Date.parse(to);
  const toMs = Number.isFinite(toParsed) ? toParsed : Number.POSITIVE_INFINITY;

  // Per-env accumulator.
  interface Acc {
    deployments: number;
    deployTimeFailures: number;
    attempts: number;
    leadGaps: number[];
  }
  const envs = new Map<string, Acc>();
  const accFor = (env: string): Acc => {
    let a = envs.get(env);
    if (!a) { a = { deployments: 0, deployTimeFailures: 0, attempts: 0, leadGaps: [] }; envs.set(env, a); }
    return a;
  };

  // A deploy row counts toward DF/CFR/lead only if it completed inside [from,to].
  // Look-back-only rows (in_window=false, kept for incident correlation) are
  // skipped here. Absent in a fixture ⇒ in-window (unit tests omit the flag).
  const isInWindow = (row: DeployRow): boolean =>
    row.in_window == null ? true : (row.in_window === true || row.in_window === 't');

  for (const row of deployRows) {
    const env = row.environment;
    if (!env) continue;
    if (!isInWindow(row)) continue; // look-back-only row → correlation, not DF/CFR
    const a = accFor(env);
    if (row.status === 'SUCCEEDED') {
      a.deployments++;
      a.attempts++;
      // Measured lead time: deploy completion − execution's earliest commit time.
      if (row.commit_ts != null && row.completed_at != null) {
        const gap = (Date.parse(row.completed_at) - Date.parse(row.commit_ts)) / 1000;
        if (Number.isFinite(gap)) a.leadGaps.push(Math.max(gap, 0));
      }
    } else if (row.status === 'FAILED') {
      a.deployTimeFailures++;
      a.attempts++;
    }
  }

  // Incident→deploy correlation (Phase 5). Index the SUCCESSFUL deploys per env
  // (execution id + completion instant), newest first, so each incident can be
  // attributed to the most recent deploy that completed within the window
  // before it opened. That execution is a post-deploy failure.
  const windowMs = windowHours * 3600 * 1000;
  const successfulByEnv = new Map<string, Array<{ exec: string; completedMs: number }>>();
  for (const row of deployRows) {
    if (row.status !== 'SUCCEEDED' || !row.environment || row.execution_id == null || row.completed_at == null) continue;
    const ms = Date.parse(row.completed_at);
    if (!Number.isFinite(ms)) continue;
    const list = successfulByEnv.get(row.environment) ?? [];
    list.push({ exec: row.execution_id, completedMs: ms });
    successfulByEnv.set(row.environment, list);
  }
  for (const list of successfulByEnv.values()) list.sort((a, b) => b.completedMs - a.completedMs);

  /** Correlate an incident to the most recent in-window successful deploy execution. */
  const correlate = (env: string, openedMs: number): string | null => {
    const list = successfulByEnv.get(env);
    if (!list) return null;
    for (const d of list) {
      if (d.completedMs <= openedMs && openedMs - d.completedMs <= windowMs) return d.exec;
    }
    return null;
  };

  // Correlated incidents (all envs → CFR; production subset → MTTR). Each carries
  // the deploy execution it attributes to + its real recovery gap (when resolved).
  interface CorrelatedIncident { environment: string; exec: string; resolvedGap: number | null }
  const correlatedIncidents: CorrelatedIncident[] = [];
  for (const inc of incidentRows) {
    if (!inc.environment || inc.opened_at == null) continue;
    const openedMs = Date.parse(inc.opened_at);
    if (!Number.isFinite(openedMs)) continue;
    const exec = correlate(inc.environment, openedMs);
    if (exec == null) continue; // uncorrelated → not attributable to a deploy
    let resolvedGap: number | null = null;
    if (inc.resolved_at != null) {
      const resolvedMs = Date.parse(inc.resolved_at);
      // Right-censoring: a resolution AFTER the window end (`to`) is not observed
      // within the window — treat the incident as still open (gap stays null) so
      // MTTR never reads unbounded past `to`. The incident still counts toward the
      // incident total (unresolved), it just contributes no recovery time.
      if (Number.isFinite(resolvedMs) && resolvedMs <= toMs) {
        const g = (resolvedMs - openedMs) / 1000;
        if (Number.isFinite(g)) resolvedGap = Math.max(g, 0);
      }
    }
    correlatedIncidents.push({ environment: inc.environment, exec, resolvedGap });
  }

  // Post-deploy failures per env — the DISTINCT set of deploy executions flagged
  // by a manual `failed` outcome OR a correlated incident (deduped by execution,
  // so a deploy flagged by both counts once). A manual outcome without an
  // execution id (legacy/unresolvable) still counts via a per-row sentinel.
  const postDeployExecsByEnv = new Map<string, Set<string>>();
  let sentinel = 0;
  const flagFor = (env: string): Set<string> => {
    let s = postDeployExecsByEnv.get(env);
    if (!s) { s = new Set<string>(); postDeployExecsByEnv.set(env, s); }
    return s;
  };
  for (const o of outcomeRows) {
    if (o.outcome !== 'failed' || !o.environment) continue;
    flagFor(o.environment).add(o.execution_id ?? `manual-${sentinel++}`);
    accFor(o.environment); // ensure env appears even with no deploy events
  }
  for (const ci of correlatedIncidents) {
    flagFor(ci.environment).add(ci.exec);
    accFor(ci.environment); // ensure env appears even if the deploy is out-of-window
  }
  const postDeployByEnv = new Map<string, number>();
  for (const [env, set] of postDeployExecsByEnv) postDeployByEnv.set(env, set.size);

  const environments: DoraEnvMetrics[] = [...envs.entries()]
    // The deploy and incident scans admit PRODUCTION alongside a requested
    // environment so MTTR can correlate production incidents (see
    // `scanEnvClause`). That production row is plumbing for MTTR, not something
    // the caller asked to see — report only the environment that was requested.
    .filter(([environment]) => !filters.environment || environment === filters.environment)
    .map(([environment, a]) => {
      const postDeployFailures = postDeployByEnv.get(environment) ?? 0;
      const rawPerDay = a.deployments / days;
      const numerator = a.deployTimeFailures + postDeployFailures;
      // Clamp to [0,100]: post-deploy failures can correlate to a deploy that
      // completed just before the window (kept for correlation), so the numerator
      // can transiently exceed in-window attempts — a CFR > 100% is never valid.
      const rawRate = a.attempts > 0 ? Math.min(100, (numerator / a.attempts) * 100) : 0;
      const ltMedian = median(a.leadGaps);
      return {
        environment,
        deploymentFrequency: {
          deployments: a.deployments,
          perDay: round(rawPerDay, 2),
          level: doraLevelForFrequency(rawPerDay, a.deployments),
        },
        changeFailureRate: {
          rate: round(rawRate, 1),
          deployTimeFailures: a.deployTimeFailures,
          postDeployFailures,
          attempts: a.attempts,
          level: doraLevelForChangeFailure(rawRate, a.attempts),
        },
        leadTime: {
          deployments: a.leadGaps.length,
          medianSeconds: ltMedian != null ? round(ltMedian, 1) : null,
          level: doraLevelForLeadTime(ltMedian),
        },
      };
    })
    .sort((x, y) => {
      if (x.environment === HEADLINE_ENV) return -1;
      if (y.environment === HEADLINE_ENV) return 1;
      return x.environment.localeCompare(y.environment);
    });

  // MTTR — PRODUCTION-ONLY, from BOTH sources. Incidents take precedence: a
  // production incident correlated to a deploy contributes the real recovery
  // (`resolved_at − opened_at`), and any manual outcome on the SAME deploy is
  // skipped. Manual outcomes on other deploys keep the Phase-2 behavior
  // (`failed` → an incident; `restored` → a recovery gap of `restored − deployed`).
  let incidents = 0, restored = 0;
  const mttrGaps: number[] = [];
  // Executions already attributed to a production incident (precedence guard).
  const incidentExecs = new Set<string>();
  for (const ci of correlatedIncidents) {
    if (ci.environment !== HEADLINE_ENV) continue; // MTTR is production-only
    incidents++;
    incidentExecs.add(ci.exec);
    if (ci.resolvedGap != null) { restored++; mttrGaps.push(ci.resolvedGap); }
  }
  for (const m of mttrRows) {
    // Incident precedence: don't double-count a deploy already flagged by an incident.
    if (m.execution_id != null && incidentExecs.has(m.execution_id)) continue;
    if (m.outcome === 'failed') { incidents++; continue; }
    if (m.outcome === 'restored') {
      restored++;
      if (m.restored_at != null && m.deployed_at != null) {
        const gap = (Date.parse(m.restored_at) - Date.parse(m.deployed_at)) / 1000;
        if (Number.isFinite(gap)) mttrGaps.push(Math.max(gap, 0));
      }
    }
  }
  const mttrMedian = median(mttrGaps);

  const registered = Number(coverageRow?.registered) || 0;
  const deploying = Number(coverageRow?.deploying) || 0;

  return {
    window: { from, to },
    filters: { pipelineId: filters.pipelineId ?? null, environment: filters.environment ?? null },
    headline: HEADLINE_ENV,
    environments,
    meanTimeToRestore: {
      incidents,
      restored,
      medianSeconds: mttrMedian != null ? round(mttrMedian, 1) : null,
      level: doraLevelForRestore(mttrMedian),
    },
    coverage: {
      registered,
      deploying,
      withoutDeploys: Math.max(registered - deploying, 0),
    },
  };
}

/**
 * 1.9b DORA trend — deployment frequency + deploy-time change-failure rate
 * bucketed by `interval` (day/week/month) for a sparkline. Deploy-basis like
 * getDoraMetrics: buckets terminal deploy-stage executions on their
 * `completed_at`. Shares the org/rollup + pipelineId/environment scoping. MTTR,
 * lead time, and post-deploy CFR are intentionally omitted (too heavy to bucket).
 */
export async function getDoraTrend(
  orgId: string,
  interval: string,
  from: string,
  to: string,
  orgIds?: string[],
  opts: DoraOptions = {},
): Promise<DoraTrendPoint[]> {
  assertReportInterval(interval);
  const { pred, multi } = orgScope(orgId, orgIds);
  const { pipelineId, environment } = opts;
  const pipelineClause = pipelineId ? sql`AND e.pipeline_id = ${pipelineId}` : sql``;
  const envClause = environment ? sql`AND e.environment = ${environment}` : sql``;
  const exec = () => withTenantTx((tx) => tx.execute(sql`
      WITH deploys AS (
        -- PER-EXECUTION deploy unit (D1): one row per (environment, execution),
        -- every deploy STAGE to that env within the execution rolled up to a
        -- single terminal status — NOT one row per stage.
        SELECT
          ${terminalStatusRollup} AS status,
          MAX(e.completed_at) AS completed_at
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.environment IS NOT NULL
          ${pipelineClause} ${envClause}
          AND e.completed_at >= ${from}::timestamptz AND e.completed_at <= ${to}::timestamptz
        GROUP BY e.environment, e.execution_id
      )
      SELECT
        DATE_TRUNC(${interval}, completed_at)::text AS period,
        COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS deployments,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE status IN ('SUCCEEDED', 'FAILED'))::int AS total,
        -- quoted alias so the raw row key is exactly the DoraTrendPoint field
        COALESCE(ROUND(COUNT(*) FILTER (WHERE status = 'FAILED')::numeric
          / NULLIF(COUNT(*) FILTER (WHERE status IN ('SUCCEEDED', 'FAILED')), 0) * 100, 1), 0)::float AS "changeFailurePct"
      FROM deploys
      GROUP BY period ORDER BY period
    `).then(r => drizzleRows<DoraTrendPoint>(r.rows)));
  const key = `${orgId}:dora-trend:${interval}:${from}:${to}:${pipelineId ?? ''}:${environment ?? ''}`;
  return runReport(key, multi, exec);
}

/**
 * 1.10 Per-pipeline BUILD HEALTH (Phase 6) — a standard (NOT `advanced_reporting`)
 * per-stage breakdown for one pipeline over a [from,to] window. Aggregates the
 * existing `pipeline_events` STAGE rows: each stage is rolled up per execution
 * to a terminal status (FAILED wins, then SUCCEEDED) + its max duration, then
 * grouped per stage into run/success/failure counts, a success rate, and
 * duration percentiles (p50/p90/p99). Totals sum across stages. Org-scoped via
 * the pipeline join (`p.org_id ${pred}`) + rollup-aware like the sibling reports;
 * a pipelineId owned by another org returns an empty breakdown.
 */
export async function getBuildHealth(
  orgId: string,
  pipelineId: string,
  from: string,
  to: string,
  orgIds?: string[],
): Promise<BuildHealth> {
  const { pred, multi } = orgScope(orgId, orgIds);
  const exec = () => withTenantTx(async (tx) => {
    const rows = drizzleRows<BuildHealthStage>((await tx.execute(sql`
      WITH stage_runs AS (
        SELECT
          e.stage_name AS stage,
          ${terminalStatusRollup} AS status,
          MAX(e.duration_ms) AS duration_ms
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.pipeline_id = ${pipelineId}
          AND e.event_type = 'STAGE' AND e.stage_name IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY e.stage_name, e.execution_id
      )
      SELECT
        stage,
        COUNT(*)::int AS runs,
        COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS successes,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failures,
        COALESCE(ROUND(COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::numeric
          / NULLIF(COUNT(*), 0) * 100, 1), 0)::float AS "successRate",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS "p50Ms",
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duration_ms)::int AS "p90Ms",
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS "p99Ms"
      FROM stage_runs
      WHERE status IN ('SUCCEEDED', 'FAILED')
      GROUP BY stage
      ORDER BY runs DESC, stage
    `)).rows);

    // Totals sum across stages (total stage-runs / stage-failures in the window).
    let runs = 0, failures = 0;
    for (const s of rows) { runs += s.runs; failures += s.failures; }
    const failureRate = runs > 0 ? round((failures / runs) * 100, 1) : 0;
    return { stages: rows, totals: { runs, failures, failureRate } };
  });
  return runReport(`${orgId}:build-health:${pipelineId}:${from}:${to}`, multi, exec);
}

// ── Category 2: Plugin Inventory & Builds ──

/** 2.1 Plugin summary — counts and breakdowns.
 *  INTENTIONALLY SINGLE-ORG (no rollup): plugin inventory is an org-owned
 *  asset count, not an execution/build activity report, so a parent's view is
 *  its own plugins — teams manage their own inventory. Single `= $org` scope. */
