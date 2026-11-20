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

import type { WeekStart } from '@pipeline-builder/api-core';
import { sql, type SQL } from 'drizzle-orm';
import {
  HEADLINE_ENV, DORA_INCIDENT_WINDOW_HOURS, resolveIncidentWindowHours,
  doraLevelForFrequency, doraLevelForChangeFailure, doraLevelForRestore, doraLevelForLeadTime,
  round, median, percentile,
} from './dora-scoring.js';
import { orgScope, runReport } from './query-scope.js';
import { assertReportInterval, bucketKey, notOvertaken, periodBucket, terminalStatusRollup } from './sql-helpers.js';
import type {
  DoraOptions, DoraMetrics, DoraEnvMetrics, DoraTrendPoint, BuildHealth, BuildHealthStage,
  DeployRow, OutcomeRow, MttrPairRow, IncidentRow, CoverageRow,
} from './types.js';
import { schema } from '../../database/drizzle-schema.js';
import { withTenantTx } from '../../database/tenancy.js';
import { drizzleRows } from '../crud-service.js';

/**
 * DORA metrics over a [from,to] deploy-completion window, org-scoped +
 * rollup-aware. DEPLOY-BASIS ONLY — every metric derives from real deploy-stage
 * executions (`event_type='STAGE'` with a non-null `environment`, set by the
 * forwarder for the stages a user declared in `pb.deploys`). No run-based
 * fallback: a pipeline with no deploy stage produces no DORA data.
 *
 * Four scoped SQL scans run inside one tx (each org-gated by `p.org_id ${pred}`
 * / `o.org_id ${pred}` so a rollup passes the org→team subtree and a foreign
 * org's rows never enter): (1) terminal deploy rows PER (execution, env) — one
 * "deployment" = one execution reaching an env — → DF / deploy-time CFR /
 * measured lead time (lead time joins the execution's earliest commit);
 * the scan also reaches back `windowHours` before `from` so incidents opened
 * near the window start can correlate to a just-prior deploy; (2) `deployment_outcomes`
 * anchored to their deploy's completion → post-deploy CFR component; (3)
 * production restored/failed outcomes paired with their failure → MTTR; (4)
 * registry vs deploying → coverage.
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

  const { deploySql, outcomeSql, incidentSql } = doraScans({
    pred,
    from,
    to,
    lookbackFrom,
    windowHours: effectiveWindowHours,
    pipelineClause,
    deployEnvClause: scanEnvClause,
    outcomeEnvClause,
    outcomePipelineClause,
    incidentEnvClause: scanIncidentEnvClause,
  });

  // (3) MTTR — PRODUCTION-ONLY, independent of the env filter. Every production
  // outcome in-window. A 'restored' one is measured from the FAILURE it ended:
  // the same deploy's `failed` marker (`failed_at`). Only when there is no failed
  // marker and the deploy itself FAILED is the failure instant the deploy's
  // completion (`deployed_at`, with `deploy_failed` true); a 'restored' marker
  // with neither is not a recovery of anything and is ignored (see computeMttr).
  // It used to be measured from the deploy's completion every time, which added
  // however long the deploy had been healthy BEFORE it broke to every recovery.
  // execution_id is projected so an incident-sourced recovery for the same
  // deploy takes precedence over the manual pair.
  const mttrSql = sql`
      SELECT
        o.outcome AS outcome,
        o.execution_id AS execution_id,
        o.at::text AS restored_at,
        (SELECT MAX(f.at) FROM ${schema.deploymentOutcome} f
           WHERE f.org_id ${pred} AND f.execution_id = o.execution_id
             AND f.outcome = 'failed')::text AS failed_at,
        (SELECT MAX(d.completed_at) FROM ${schema.pipelineEvent} d
           JOIN ${schema.pipeline} p2 ON p2.id = d.pipeline_id
           WHERE p2.org_id ${pred} AND d.execution_id = o.execution_id
             AND d.event_type = 'STAGE' AND d.environment = ${HEADLINE_ENV})::text AS deployed_at,
        EXISTS (SELECT 1 FROM ${schema.pipelineEvent} e
           JOIN ${schema.pipeline} p3 ON p3.id = e.pipeline_id
           WHERE p3.org_id ${pred} AND e.execution_id = o.execution_id
             AND e.event_type = 'STAGE' AND e.environment = ${HEADLINE_ENV}
             AND e.status = 'FAILED' AND ${notOvertaken}) AS deploy_failed
      FROM ${schema.deploymentOutcome} o
      WHERE o.org_id ${pred} AND o.environment = ${HEADLINE_ENV} ${outcomePipelineClause}
        AND o.at >= ${from}::timestamptz AND o.at <= ${to}::timestamptz`;

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
    const mttrRows = drizzleRows<MttrPairRow>((await tx.execute(mttrSql)).rows);
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

/** What {@link doraScans} needs: the org predicate, the window, and the scoping clauses. */
interface DoraScanInput {
  pred: ReturnType<typeof orgScope>['pred'];
  from: string;
  to: string;
  /** `from − windowHours`: deploys this far back are kept for incident correlation. */
  lookbackFrom: string;
  windowHours: number;
  pipelineClause: SQL;
  deployEnvClause: SQL;
  outcomeEnvClause: SQL;
  outcomePipelineClause: SQL;
  incidentEnvClause: SQL;
  /** When set, each deploy row also carries its time bucket (the trend). */
  bucket?: { interval: string; tz: string; weekStart: WeekStart };
}

/**
 * The three scans the change-failure rate is built from, shared by the headline
 * ({@link getDoraMetrics}) and the trend ({@link getDoraTrend}) so the two cannot
 * count it differently. They used to: the trend counted deploy-time failures only
 * while the headline added post-deploy failures, so the sparkline read better
 * than the number above it.
 *
 * (1) Terminal deploy rows: PER-EXECUTION, one row per (environment,
 * execution) — every deploy STAGE targeting that env within the execution is
 * rolled up to a terminal status (FAILED wins, then SUCCEEDED). A single
 * execution with two deploy stages to the same env is ONE deployment, not two.
 * completed_at = the deploy's completion (MAX over its stages). `commit_ts`
 * is the execution's EARLIEST commit time across ALL its events (commit
 * enrichment rides the PIPELINE/source event where environment IS NULL, never
 * the deploy STAGE row), joined by execution_id. `in_window` marks whether the
 * deploy completed inside [from,to] (vs. a look-back-only row kept solely for
 * incident correlation). execution_id is projected so post-deploy failures
 * (manual outcomes + correlated incidents) can dedup against their deploy.
 *
 * (2) Manual `failed` outcome markers, ANCHORED TO THEIR DEPLOY: an outcome
 * counts in the window its deploy completed in, whenever the marker was
 * recorded. Windowing them on their own `at` put a deploy completed on the 31st
 * and marked failed on the 1st in NEXT month's CFR numerator, against this
 * month's attempts — a numerator and denominator from different windows, which
 * is how a CFR could exceed 100%.
 *
 * (3) Incidents opened from `from` to `to + windowHours`: an incident opened just
 * after the window can still follow an in-window deploy (and, anchored to that
 * deploy, counts in this window's CFR). `opened_in_window` keeps MTTR to the
 * incidents actually opened in the window.
 */
function doraScans(input: DoraScanInput): { deploySql: SQL; outcomeSql: SQL; incidentSql: SQL } {
  const { pred, from, to, lookbackFrom, windowHours, pipelineClause, deployEnvClause, bucket } = input;
  const toMs = Date.parse(to);
  const incidentTo = Number.isFinite(toMs) ? new Date(toMs + windowHours * 3600 * 1000).toISOString() : to;
  const periodCol = bucket
    ? sql`, ${periodBucket(bucket.interval, sql`ds.completed_at`, bucket.tz, bucket.weekStart)}::text AS period`
    : sql``;

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
          AND ${notOvertaken}
          ${pipelineClause} ${deployEnvClause}
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
        ${periodCol}
      FROM deploy_stages ds
      LEFT JOIN exec_commits ec ON ec.execution_id = ds.execution_id`;

  const outcomeSql = sql`
      SELECT o.environment AS environment, o.outcome AS outcome, o.execution_id AS execution_id
      FROM ${schema.deploymentOutcome} o
      WHERE o.org_id ${pred} ${input.outcomeEnvClause} ${input.outcomePipelineClause}
        AND o.outcome = 'failed'
        AND o.execution_id IN (
          SELECT e.execution_id FROM ${schema.pipelineEvent} e
          JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
          WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.environment IS NOT NULL
            ${pipelineClause}
            AND e.completed_at >= ${from}::timestamptz AND e.completed_at <= ${to}::timestamptz
        )`;

  const incidentSql = sql`
      SELECT i.environment AS environment, i.opened_at::text AS opened_at, i.resolved_at::text AS resolved_at,
        (i.opened_at <= ${to}::timestamptz) AS opened_in_window
      FROM ${schema.incident} i
      WHERE i.org_id ${pred} ${input.incidentEnvClause}
        AND i.opened_at >= ${from}::timestamptz AND i.opened_at <= ${incidentTo}::timestamptz`;

  return { deploySql, outcomeSql, incidentSql };
}

/** Per-environment deploy accumulator. */
interface EnvAcc {
  deployments: number;
  deployTimeFailures: number;
  attempts: number;
  leadGaps: number[];
}

/** A production-or-other incident attributed to the deploy execution it followed. */
interface CorrelatedIncident {
  environment: string;
  exec: string;
  resolvedGap: number | null;
  /** The deploy it follows completed inside [from,to] — it then counts in this window's CFR. */
  deployInWindow: boolean;
  /** The incident was opened inside [from,to] — it then counts in this window's MTTR. */
  openedInWindow: boolean;
}

/** Get-or-create the accumulator for `env`. */
function accFor(envs: Map<string, EnvAcc>, env: string): EnvAcc {
  let a = envs.get(env);
  if (!a) { a = { deployments: 0, deployTimeFailures: 0, attempts: 0, leadGaps: [] }; envs.set(env, a); }
  return a;
}

/** A pg boolean read back as `true`/`'t'`; absent (a unit fixture) ⇒ `true`. */
function flag(value: boolean | string | null | undefined): boolean {
  return value == null ? true : (value === true || value === 't');
}

/**
 * A deploy row counts toward DF/CFR/lead only if it completed inside [from,to].
 * Look-back-only rows (in_window=false, kept for incident correlation) are
 * skipped. Absent in a fixture ⇒ in-window (unit tests omit the flag).
 */
function isInWindow(row: DeployRow): boolean {
  return flag(row.in_window);
}

/** The dedup key of one deployment: one execution reaching one environment. */
const deployKey = (env: string, exec: string): string => `${env}\u0000${exec}`;

/** Bucket the in-window terminal deploy rows by environment (DF / deploy-time CFR / measured lead). */
function accumulateDeploys(deployRows: DeployRow[]): Map<string, EnvAcc> {
  const envs = new Map<string, EnvAcc>();
  for (const row of deployRows) {
    const env = row.environment;
    if (!env) continue;
    if (!isInWindow(row)) continue; // look-back-only row → correlation, not DF/CFR
    const a = accFor(envs, env);
    if (row.status === 'SUCCEEDED') {
      a.deployments++;
      a.attempts++;
      // Measured lead time: deploy completion − execution's earliest commit time.
      //
      // Still clamped ≥0, unlike the single-event timestamp checks that now run at
      // INGEST. The two instants come from DIFFERENT rows — `commit_timestamp` off
      // the PIPELINE/source event, `completed_at` off the deploy STAGE event —
      // joined only here by execution_id, so no ingest-time check can see the
      // pair. A commit dated after its own deploy means a rewritten history or a
      // skewed SCM clock, and 0 is the honest floor for "shipped immediately".
      if (row.commit_ts != null && row.completed_at != null) {
        const gap = (Date.parse(row.completed_at) - Date.parse(row.commit_ts)) / 1000;
        if (Number.isFinite(gap)) a.leadGaps.push(Math.max(gap, 0));
      }
    } else if (row.status === 'FAILED') {
      a.deployTimeFailures++;
      a.attempts++;
    }
  }
  return envs;
}

/**
 * Incident→deploy correlation. Each incident is attributed to the most recent
 * SUCCESSFUL deploy to its environment with `completed_at ≤ opened_at` within
 * `windowHours`; an uncorrelated incident is dropped. A resolution after the
 * window end (`toMs`) is right-censored: the incident still counts, unresolved.
 */
function correlateIncidents(
  deployRows: DeployRow[],
  incidentRows: IncidentRow[],
  windowHours: number,
  toMs: number,
): CorrelatedIncident[] {
  // Index the SUCCESSFUL deploys per env (execution id + completion instant),
  // newest first.
  const windowMs = windowHours * 3600 * 1000;
  const successfulByEnv = new Map<string, Array<{ exec: string; completedMs: number; inWindow: boolean }>>();
  for (const row of deployRows) {
    if (row.status !== 'SUCCEEDED' || !row.environment || row.execution_id == null || row.completed_at == null) continue;
    const ms = Date.parse(row.completed_at);
    if (!Number.isFinite(ms)) continue;
    const list = successfulByEnv.get(row.environment) ?? [];
    list.push({ exec: row.execution_id, completedMs: ms, inWindow: isInWindow(row) });
    successfulByEnv.set(row.environment, list);
  }
  for (const list of successfulByEnv.values()) list.sort((a, b) => b.completedMs - a.completedMs);

  const correlate = (env: string, openedMs: number) => {
    const list = successfulByEnv.get(env);
    if (!list) return null;
    for (const d of list) {
      if (d.completedMs <= openedMs && openedMs - d.completedMs <= windowMs) return d;
    }
    return null;
  };

  const correlated: CorrelatedIncident[] = [];
  for (const inc of incidentRows) {
    if (!inc.environment || inc.opened_at == null) continue;
    const openedMs = Date.parse(inc.opened_at);
    if (!Number.isFinite(openedMs)) continue;
    const deploy = correlate(inc.environment, openedMs);
    if (deploy == null) continue; // uncorrelated → not attributable to a deploy
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
    correlated.push({
      environment: inc.environment,
      exec: deploy.exec,
      resolvedGap,
      deployInWindow: deploy.inWindow,
      openedInWindow: flag(inc.opened_in_window),
    });
  }
  return correlated;
}

/**
 * Post-deploy failures — the DISTINCT set of in-window SUCCESSFUL deployments
 * flagged by a manual `failed` outcome OR a correlated incident (deduped by
 * execution, so a deploy flagged by both counts once), as `deployKey`s.
 *
 * ANCHORED TO THE DEPLOY: a flag counts in the window its deploy completed in,
 * so the numerator and the attempts it is divided by always describe the same
 * deployments. A failed marker on a deploy that already failed at deploy time
 * adds nothing — that deployment is already one failure.
 */
function postDeployFailedKeys(
  deployRows: DeployRow[],
  outcomeRows: OutcomeRow[],
  correlated: CorrelatedIncident[],
): Set<string> {
  const inWindowSuccess = new Set<string>();
  for (const row of deployRows) {
    if (row.status === 'SUCCEEDED' && row.environment && row.execution_id != null && isInWindow(row)) {
      inWindowSuccess.add(deployKey(row.environment, row.execution_id));
    }
  }
  const flagged = new Set<string>();
  for (const o of outcomeRows) {
    if (o.outcome !== 'failed' || !o.environment || o.execution_id == null) continue;
    const key = deployKey(o.environment, o.execution_id);
    if (inWindowSuccess.has(key)) flagged.add(key);
  }
  for (const ci of correlated) {
    if (ci.deployInWindow) flagged.add(deployKey(ci.environment, ci.exec));
  }
  return flagged;
}

/** {@link postDeployFailedKeys} counted per environment. */
function countPostDeployFailures(flagged: Set<string>): Map<string, number> {
  const byEnv = new Map<string, number>();
  for (const key of flagged) {
    const env = key.slice(0, key.indexOf('\u0000'));
    byEnv.set(env, (byEnv.get(env) ?? 0) + 1);
  }
  return byEnv;
}

/** Per-environment DF / CFR / lead-time rows, production first. */
function buildEnvMetrics(
  envs: Map<string, EnvAcc>,
  postDeployByEnv: Map<string, number>,
  days: number,
  requestedEnv: string | undefined,
): DoraEnvMetrics[] {
  return [...envs.entries()]
    // The deploy and incident scans admit PRODUCTION alongside a requested
    // environment so MTTR can correlate production incidents (see
    // `scanEnvClause`). That production row is plumbing for MTTR, not something
    // the caller asked to see — report only the environment that was requested.
    .filter(([environment]) => !requestedEnv || environment === requestedEnv)
    .map(([environment, a]) => {
      const postDeployFailures = postDeployByEnv.get(environment) ?? 0;
      const rawPerDay = a.deployments / days;
      const numerator = a.deployTimeFailures + postDeployFailures;
      // Anchored to the deploy (postDeployFailedKeys), the numerator can no longer
      // exceed the attempts; the clamp stays as a guard, since a CFR > 100% is
      // never valid.
      const rawRate = a.attempts > 0 ? Math.min(100, (numerator / a.attempts) * 100) : 0;
      const ltMedian = median(a.leadGaps);
      return {
        environment,
        deploymentFrequency: {
          deployments: a.deployments,
          perDay: round(rawPerDay, 2),
          level: doraLevelForFrequency(rawPerDay, a.deployments),
          n: a.deployments,
        },
        changeFailureRate: {
          rate: round(rawRate, 1),
          deployTimeFailures: a.deployTimeFailures,
          postDeployFailures,
          attempts: a.attempts,
          level: doraLevelForChangeFailure(rawRate, a.attempts),
          n: a.attempts,
        },
        leadTime: {
          deployments: a.leadGaps.length,
          medianSeconds: ltMedian != null ? round(ltMedian, 1) : null,
          ...tails(a.leadGaps),
          // Scored off the MEDIAN only — the tails are reported, not banded.
          level: doraLevelForLeadTime(ltMedian, a.leadGaps.length),
          n: a.leadGaps.length,
        },
      };
    })
    .sort((x, y) => {
      if (x.environment === HEADLINE_ENV) return -1;
      if (y.environment === HEADLINE_ENV) return 1;
      return x.environment.localeCompare(y.environment);
    });
}

/**
 * p90/p95 of a gap sample, rounded like the median beside them. One helper so
 * lead time and MTTR cannot drift in how they report their tails.
 */
function tails(gaps: number[]): { p90Seconds: number | null; p95Seconds: number | null } {
  const p90 = percentile(gaps, 90);
  const p95 = percentile(gaps, 95);
  return {
    p90Seconds: p90 != null ? round(p90, 1) : null,
    p95Seconds: p95 != null ? round(p95, 1) : null,
  };
}

/**
 * Time to restore (the MEDIAN, despite the field's historical `meanTimeToRestore`
 * name) — PRODUCTION-ONLY, from BOTH sources. Incidents take precedence: a
 * production incident opened in the window and correlated to a deploy contributes
 * the real recovery (`resolved_at − opened_at`), and any manual outcome on the
 * SAME deploy is skipped. Manual outcomes on other deploys count as recorded:
 *  - `failed` → an incident;
 *  - `restored` → a recovery measured FROM THE FAILURE: `restored − failed`,
 *    the same deploy's `failed` marker. With no failed marker, only a deploy that
 *    itself FAILED has a failure to recover from, and its failure instant is the
 *    deploy's completion (`restored − deployed`; that failure is also counted as
 *    the incident). A `restored` marker with no failure at all is not a recovery
 *    and adds nothing — it used to add to `restored` and contribute
 *    `restored − deployed`, i.e. however long the deploy had been healthy.
 */
function computeMttr(
  correlated: CorrelatedIncident[],
  mttrRows: MttrPairRow[],
): DoraMetrics['meanTimeToRestore'] {
  let incidents = 0, restored = 0;
  const mttrGaps: number[] = [];
  // Executions already attributed to a production incident (precedence guard).
  const incidentExecs = new Set<string>();
  for (const ci of correlated) {
    if (ci.environment !== HEADLINE_ENV) continue; // MTTR is production-only
    if (!ci.openedInWindow) continue; // opened after `to`: next window's incident
    incidents++;
    incidentExecs.add(ci.exec);
    if (ci.resolvedGap != null) { restored++; mttrGaps.push(ci.resolvedGap); }
  }
  for (const m of mttrRows) {
    // Incident precedence: don't double-count a deploy already flagged by an incident.
    if (m.execution_id != null && incidentExecs.has(m.execution_id)) continue;
    if (m.outcome === 'failed') { incidents++; continue; }
    if (m.outcome !== 'restored') continue;
    const deployFailed = flag(m.deploy_failed ?? false);
    const failedAt = m.failed_at ?? (deployFailed ? m.deployed_at : null);
    if (failedAt == null) continue; // nothing failed: not a recovery
    if (m.failed_at == null) incidents++; // the deploy-time failure is the incident
    restored++;
    if (m.restored_at != null) {
      const gap = (Date.parse(m.restored_at) - Date.parse(failedAt)) / 1000;
      if (Number.isFinite(gap)) mttrGaps.push(Math.max(gap, 0));
    }
  }
  const mttrMedian = median(mttrGaps);
  return {
    incidents,
    restored,
    medianSeconds: mttrMedian != null ? round(mttrMedian, 1) : null,
    ...tails(mttrGaps),
    level: doraLevelForRestore(mttrMedian, mttrGaps.length),
    n: mttrGaps.length,
  };
}

/** Window length in days, floored at 1 (a sub-day window reads its count as the rate). */
function windowDays(from: string, to: string): number {
  const spanDays = (Date.parse(to) - Date.parse(from)) / 86400000;
  return Number.isFinite(spanDays) ? Math.max(spanDays, 1) : 1;
}

/** The window end instant for right-censoring; +Infinity when unparseable (fail-open). */
function windowEndMs(to: string): number {
  const toParsed = Date.parse(to);
  return Number.isFinite(toParsed) ? toParsed : Number.POSITIVE_INFINITY;
}

/**
 * Shape the raw DORA scan rows into the public {@link DoraMetrics}: per-env
 * DF / CFR / lead time (post-deploy failures folded in), production MTTR from
 * incidents + manual outcomes, and deploy coverage — all cross-source medians
 * over deltas clamped ≥0.
 */
function shapeDora(
  deployRows: DeployRow[],
  outcomeRows: OutcomeRow[],
  mttrRows: MttrPairRow[],
  coverageRow: CoverageRow | undefined,
  incidentRows: IncidentRow[],
  from: string,
  to: string,
  filters: { pipelineId?: string; environment?: string },
  windowHours: number = DORA_INCIDENT_WINDOW_HOURS,
): DoraMetrics {
  const days = windowDays(from, to);
  const toMs = windowEndMs(to);

  const envs = accumulateDeploys(deployRows);
  const correlated = correlateIncidents(deployRows, incidentRows, windowHours, toMs);
  const postDeployByEnv = countPostDeployFailures(postDeployFailedKeys(deployRows, outcomeRows, correlated));

  const registered = Number(coverageRow?.registered) || 0;
  const deploying = Number(coverageRow?.deploying) || 0;

  return {
    window: { from, to },
    filters: { pipelineId: filters.pipelineId ?? null, environment: filters.environment ?? null },
    headline: HEADLINE_ENV,
    environments: buildEnvMetrics(envs, postDeployByEnv, days, filters.environment),
    meanTimeToRestore: computeMttr(correlated, mttrRows),
    coverage: {
      registered,
      deploying,
      withoutDeploys: Math.max(registered - deploying, 0),
    },
  };
}

/**
 * Bucket the in-window deploys for the trend — the SAME change-failure rate as
 * the headline, per bucket: deploy-time failures plus post-deploy failures
 * (manual markers and correlated incidents), each anchored to the bucket its
 * deploy completed in. Summed over the buckets, `failed`, `postDeployFailures`
 * and `total` are exactly the headline's `deployTimeFailures`,
 * `postDeployFailures` and `attempts` for the same window and scope.
 */
function shapeTrend(
  deployRows: Array<DeployRow & { period?: string | null }>,
  outcomeRows: OutcomeRow[],
  incidentRows: IncidentRow[],
  to: string,
  windowHours: number,
): DoraTrendPoint[] {
  const correlated = correlateIncidents(deployRows, incidentRows, windowHours, windowEndMs(to));
  const flagged = postDeployFailedKeys(deployRows, outcomeRows, correlated);
  const buckets = new Map<string, DoraTrendPoint>();
  for (const row of deployRows) {
    if (!row.environment || !isInWindow(row) || row.period == null) continue;
    if (row.status !== 'SUCCEEDED' && row.status !== 'FAILED') continue;
    let b = buckets.get(row.period);
    if (!b) {
      b = { period: row.period, deployments: 0, failed: 0, postDeployFailures: 0, total: 0, changeFailurePct: 0 };
      buckets.set(row.period, b);
    }
    b.total++;
    if (row.status === 'FAILED') {
      b.failed++;
    } else {
      b.deployments++;
      if (row.execution_id != null && flagged.has(deployKey(row.environment, row.execution_id))) b.postDeployFailures++;
    }
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, changeFailurePct: b.total > 0 ? round(((b.failed + b.postDeployFailures) / b.total) * 100, 1) : 0 }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * DORA trend — deployment frequency + change-failure rate bucketed by
 * `interval` (day/week/month) for a sparkline, in the report's timezone and week
 * start. Deploy-basis like getDoraMetrics and built from the SAME scans
 * ({@link doraScans}): terminal deploy-stage executions bucketed on their
 * `completed_at`, with the two-class CFR (deploy-time + post-deploy, anchored to
 * the deploy) the headline uses. Shares the org/rollup + pipelineId/environment
 * scoping and the incident correlation window. MTTR and lead time are not
 * bucketed.
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
  const { pipelineId, environment, tz = 'UTC', weekStart = 'monday' } = opts;
  const windowHours = resolveIncidentWindowHours(opts.incidentWindowHours);
  const pipelineClause = pipelineId ? sql`AND e.pipeline_id = ${pipelineId}` : sql``;
  const outcomePipelineClause = pipelineId
    ? sql`AND o.execution_id IN (SELECT pe.execution_id FROM ${schema.pipelineEvent} pe WHERE pe.pipeline_id = ${pipelineId})`
    : sql``;
  const fromMs = Date.parse(from);
  const lookbackFrom = Number.isFinite(fromMs) ? new Date(fromMs - windowHours * 3600 * 1000).toISOString() : from;
  const { deploySql, outcomeSql, incidentSql } = doraScans({
    pred,
    from,
    to,
    lookbackFrom,
    windowHours,
    pipelineClause,
    // The trend reports only the requested environment, so — unlike the headline,
    // which widens to production for MTTR — every scan is strict.
    deployEnvClause: environment ? sql`AND e.environment = ${environment}` : sql``,
    outcomeEnvClause: environment ? sql`AND o.environment = ${environment}` : sql``,
    outcomePipelineClause,
    incidentEnvClause: environment ? sql`AND i.environment = ${environment}` : sql``,
    bucket: { interval, tz, weekStart },
  });
  const exec = () => withTenantTx(async (tx) => {
    const deployRows = drizzleRows<DeployRow & { period?: string | null }>((await tx.execute(deploySql)).rows);
    const outcomeRows = drizzleRows<OutcomeRow>((await tx.execute(outcomeSql)).rows);
    const incidentRows = drizzleRows<IncidentRow>((await tx.execute(incidentSql)).rows);
    return shapeTrend(deployRows, outcomeRows, incidentRows, to, windowHours);
  });
  // The bucketing settings belong in the key: they change which days land in which
  // period, so a Chicago answer must never be served to a UTC request. The
  // incident window too: it changes which deploys an incident is attributed to.
  const key = `${orgId}:dora-trend:${interval}:${from}:${to}:${pipelineId ?? ''}:${environment ?? ''}:${bucketKey(tz, weekStart)}:${windowHours}`;
  return runReport(key, multi, exec);
}

/**
 * Per-pipeline BUILD HEALTH — a standard (NOT `advanced_reporting`)
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
          AND ${notOvertaken}
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

/** Plugin summary — counts and breakdowns.
 *  INTENTIONALLY SINGLE-ORG (no rollup): plugin inventory is an org-owned
 *  asset count, not an execution/build activity report, so a parent's view is
 *  its own plugins — teams manage their own inventory. Single `= $org` scope. */
