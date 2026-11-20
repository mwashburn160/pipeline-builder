// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Flow: where pipeline time goes WAITING rather than working.
 *
 * Two reports, both read from raw `pipeline_events` (the daily rollup keeps
 * outcomes and durations, not waits, and a percentile cannot be rebuilt from
 * per-day aggregates):
 *
 *  - {@link getApprovalWaits} (advanced): manual-approval actions — the ACTION
 *    rows whose stored detail says `type.category = 'Approval'` (the forwarder
 *    sends CodePipeline's action detail verbatim, `type` included). The wait is
 *    the approval action's start → finish: the row's `duration_ms` when AWS
 *    declared a start time, else the gap from the action's own STARTED row.
 *    AWS reports a rejection and an expiry the same way (FAILED), so they are
 *    one count. An approval that never reached a decision (the execution was
 *    stopped, superseded or abandoned around it) is counted but has no wait.
 *  - {@link getQueueWaits} (free) / {@link getQueueWaitTrend} (advanced): how
 *    long CodeBuild actions waited for capacity (QUEUED) and for their
 *    environment (PROVISIONING) — `detail.buildPhases`, which the forwarder
 *    reads off the same BatchGetBuilds record as the compute size — plus
 *    "pipeline start → first stage start" from the PIPELINE and STAGE STARTED
 *    rows that already exist.
 *
 * Data appears for runs ingested after the release that started collecting it:
 * older rows carry no `buildPhases`, and are simply not in the queue sample.
 *
 * WINDOWS AND BUCKETS. Approvals and builds land in the bucket they FINISHED
 * in (`completed_at`), the start → first stage gap in the bucket the execution
 * STARTED in. Every bucket is in the report's timezone and week start and the
 * series is zero-filled. Org-scoped, rollup-aware (the same anchor-validated
 * subtree and elevation as every other report read). Team-level only: nothing
 * per person is read or returned.
 */

import { normalizeComputeType } from '@pipeline-builder/api-core';
import { sql, type SQL } from 'drizzle-orm';
import { bucketSeries, num, safeTz, securityRead, type SecurityBucket, type SecurityScope } from './security.js';
import { assertReportInterval, periodBucket, terminalStatusList } from './sql-helpers.js';
import { resultRows } from '../../database/pg-result.js';

/** The org + window a flow read takes (the security / analytics scope shape). */
export type FlowScope = SecurityScope;
/** How a flow series is bucketed. */
export type FlowBucket = SecurityBucket;

/** A wait distribution, in whole seconds. Null figures when nothing was measured. */
export interface WaitStats {
  n: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

/** One bucket of the approval series. */
export interface ApprovalTrendPoint {
  period: string;
  /** Approval actions that finished in the bucket, any outcome. */
  approvals: number;
  approved: number;
  /** FAILED: AWS reports a rejection and an expiry the same way. */
  rejectedOrExpired: number;
  /** Stopped / superseded / abandoned around the approval, no decision. */
  undecided: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

/** One (pipeline, stage) holding approval actions. */
export interface ApprovalStage {
  pipelineId: string;
  pipelineName: string | null;
  stageName: string;
  approvals: number;
  rejectedOrExpired: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  maxSeconds: number | null;
}

/** The approval wait report (dashboard panel). */
export interface ApprovalWaitReport {
  window: { from: string; to: string };
  totals: {
    approvals: number;
    approved: number;
    rejectedOrExpired: number;
    undecided: number;
    /** Over decided approvals (approved + rejected/expired) with a known start. */
    wait: WaitStats;
  };
  trend: ApprovalTrendPoint[];
  /** Slowest first, by p90 wait. */
  slowestStages: ApprovalStage[];
}

/** Queue / provisioning wait for one compute size. */
export interface QueueByComputeType {
  /** Our vocabulary (`MEDIUM`), the raw value when unrecognised, or `unknown`. */
  computeType: string;
  builds: number;
  queueMedianSeconds: number | null;
  queueP90Seconds: number | null;
  provisioningMedianSeconds: number | null;
  provisioningP90Seconds: number | null;
}

/** One (pipeline, stage, action) and how long its builds waited. */
export interface QueueAction {
  pipelineId: string;
  pipelineName: string | null;
  stageName: string | null;
  actionName: string | null;
  builds: number;
  queueMedianSeconds: number | null;
  queueP90Seconds: number | null;
  provisioningMedianSeconds: number | null;
  provisioningP90Seconds: number | null;
  /** p90 of queue + provisioning per build — what the list is ranked by. */
  totalWaitP90Seconds: number | null;
}

/** The queue-time report's current figures (free). */
export interface QueueWaitReport {
  window: { from: string; to: string };
  /** Builds with a measured queue or provisioning phase. */
  builds: number;
  queue: WaitStats;
  provisioning: WaitStats;
  byComputeType: QueueByComputeType[];
  /** Longest total wait (p90) first. */
  slowestActions: QueueAction[];
  /** Pipeline execution start → its first stage start. */
  startToFirstStage: WaitStats;
}

/** One bucket of the queue-time series (advanced). */
export interface QueueTrendPoint {
  period: string;
  builds: number;
  queueMedianSeconds: number | null;
  queueP90Seconds: number | null;
  provisioningMedianSeconds: number | null;
  provisioningP90Seconds: number | null;
  executions: number;
  startToFirstStageMedianSeconds: number | null;
  startToFirstStageP90Seconds: number | null;
}

/** How many rows the ranked lists carry. */
const LIST_LIMIT = 10;

const secOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(num(v)));

/** median + p90 over `expr` (seconds) — the pair every figure here reports. */
const pct = (expr: SQL, as: 'wait' | 'queue' | 'prov' | 'gap'): SQL => sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${expr}) AS ${sql.raw(`${as}_median`)},
         percentile_cont(0.9) WITHIN GROUP (ORDER BY ${expr}) AS ${sql.raw(`${as}_p90`)}`;

/** Bucket bounds shared by every read: `[from, to)` on `col`. */
const inWindow = (col: SQL, scope: FlowScope): SQL =>
  sql`${col} >= ${scope.from}::timestamptz AND ${col} < ${scope.to}::timestamptz`;

/**
 * Every approval action that FINISHED in the window, with its wait in seconds
 * (null when its start is unknown or it ended without a decision).
 */
function approvalsCte(org: SQL, scope: FlowScope): SQL {
  return sql`
    SELECT e.pipeline_id::text AS pipeline_id, p.pipeline_name AS pipeline_name, e.stage_name AS stage_name,
           e.status AS status, e.completed_at AS completed_at,
           CASE WHEN e.status IN ('SUCCEEDED', 'FAILED') THEN COALESCE(
             e.duration_ms / 1000.0,
             EXTRACT(EPOCH FROM (e.completed_at - (
               SELECT MAX(s.started_at) FROM pipeline_events s
               WHERE s.pipeline_id = e.pipeline_id AND s.execution_id = e.execution_id
                 AND s.event_type = 'ACTION' AND s.status = 'STARTED'
                 AND s.stage_name IS NOT DISTINCT FROM e.stage_name
                 AND s.action_name IS NOT DISTINCT FROM e.action_name
                 AND s.started_at <= e.completed_at)))
           ) END AS wait_s
    FROM pipeline_events e
    JOIN pipelines p ON p.id = e.pipeline_id
    WHERE p.org_id ${org} AND e.event_type = 'ACTION'
      AND e.detail -> 'type' ->> 'category' = 'Approval'
      AND e.status IN (${terminalStatusList})
      AND e.completed_at IS NOT NULL
      AND ${inWindow(sql`e.completed_at`, scope)}`;
}

/**
 * Manual approval waits: counts per outcome, median / p90 wait per bucket, and
 * the slowest approval stages. `advanced_reporting` (the route gates it).
 */
export async function getApprovalWaits(scope: FlowScope, bucket: FlowBucket): Promise<ApprovalWaitReport> {
  assertReportInterval(bucket.interval);
  const tz = safeTz(bucket.tz);
  const weekStart = bucket.weekStart ?? 'monday';
  return securityRead(scope, async (org, tx) => {
    const a = approvalsCte(org, scope);
    const counts = sql`COUNT(*)::int AS approvals,
           COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS approved,
           COUNT(*) FILTER (WHERE status = 'FAILED')::int AS rejected,
           COUNT(*) FILTER (WHERE status NOT IN ('SUCCEEDED', 'FAILED'))::int AS undecided,
           COUNT(wait_s)::int AS waits`;
    const totalsRes = await tx.execute(sql`
      WITH a AS (${a})
      SELECT ${counts}, ${pct(sql`wait_s`, 'wait')} FROM a`);
    const trendRes = await tx.execute(sql`
      WITH a AS (${a}),
      b AS ${bucketSeries(bucket.interval, scope.from, scope.to, tz, weekStart)},
      g AS (
        SELECT ${periodBucket(bucket.interval, sql`completed_at`, tz, weekStart)}::text AS period,
               ${counts}, ${pct(sql`wait_s`, 'wait')}
        FROM a GROUP BY 1)
      SELECT b.period, COALESCE(g.approvals, 0)::int AS approvals, COALESCE(g.approved, 0)::int AS approved,
             COALESCE(g.rejected, 0)::int AS rejected, COALESCE(g.undecided, 0)::int AS undecided,
             COALESCE(g.waits, 0)::int AS waits, g.wait_median, g.wait_p90
      FROM b LEFT JOIN g ON g.period = b.period
      ORDER BY b.period`);
    const stagesRes = await tx.execute(sql`
      WITH a AS (${a})
      SELECT pipeline_id, MAX(pipeline_name) AS pipeline_name, stage_name,
             COUNT(*)::int AS approvals,
             COUNT(*) FILTER (WHERE status = 'FAILED')::int AS rejected,
             COUNT(wait_s)::int AS waits,
             ${pct(sql`wait_s`, 'wait')},
             MAX(wait_s) AS wait_max
      FROM a
      WHERE stage_name IS NOT NULL
      GROUP BY pipeline_id, stage_name
      ORDER BY wait_p90 DESC NULLS LAST, approvals DESC, stage_name
      LIMIT ${LIST_LIMIT}`);

    const t = resultRows<Record<string, unknown>>(totalsRes)[0] ?? {};
    const stats = (r: Record<string, unknown>): WaitStats => {
      const n = num(r.waits);
      return { n, medianSeconds: n > 0 ? secOrNull(r.wait_median) : null, p90Seconds: n > 0 ? secOrNull(r.wait_p90) : null };
    };
    return {
      window: { from: scope.from, to: scope.to },
      totals: {
        approvals: num(t.approvals),
        approved: num(t.approved),
        rejectedOrExpired: num(t.rejected),
        undecided: num(t.undecided),
        wait: stats(t),
      },
      trend: resultRows<Record<string, unknown>>(trendRes).map((r) => {
        const s = stats(r);
        return {
          period: String(r.period),
          approvals: num(r.approvals),
          approved: num(r.approved),
          rejectedOrExpired: num(r.rejected),
          undecided: num(r.undecided),
          medianSeconds: s.medianSeconds,
          p90Seconds: s.p90Seconds,
        };
      }),
      slowestStages: resultRows<Record<string, unknown>>(stagesRes).map((r) => {
        const s = stats(r);
        return {
          pipelineId: String(r.pipeline_id),
          pipelineName: (r.pipeline_name as string | null) ?? null,
          stageName: String(r.stage_name),
          approvals: num(r.approvals),
          rejectedOrExpired: num(r.rejected),
          medianSeconds: s.medianSeconds,
          p90Seconds: s.p90Seconds,
          maxSeconds: s.n > 0 ? secOrNull(r.wait_max) : null,
        };
      }),
    };
  });
}

/**
 * Every terminal ACTION row that FINISHED in the window carrying a measured
 * queue or provisioning phase. Each is one build: a retried action ran (and
 * queued) again, so retries are not collapsed.
 */
function buildsCte(org: SQL, scope: FlowScope): SQL {
  return sql`
    SELECT e.pipeline_id::text AS pipeline_id, p.pipeline_name AS pipeline_name,
           e.stage_name AS stage_name, e.action_name AS action_name, e.completed_at AS completed_at,
           COALESCE(
             NULLIF(regexp_replace(UPPER(e.detail ->> 'computeType'), '^BUILD_GENERAL1_', ''), ''),
             'unknown') AS compute_key,
           (e.detail -> 'buildPhases' ->> 'queuedMs')::numeric / 1000.0 AS queue_s,
           (e.detail -> 'buildPhases' ->> 'provisioningMs')::numeric / 1000.0 AS prov_s
    FROM pipeline_events e
    JOIN pipelines p ON p.id = e.pipeline_id
    WHERE p.org_id ${org} AND e.event_type = 'ACTION'
      AND e.status IN (${terminalStatusList})
      AND jsonb_typeof(e.detail -> 'buildPhases') = 'object'
      AND e.completed_at IS NOT NULL
      AND ${inWindow(sql`e.completed_at`, scope)}`;
}

/**
 * One row per execution that STARTED in the window: its pipeline start and its
 * first stage start, from the STARTED rows (a RESUMED row is a retry, not the
 * first start). Executions missing either side are left out, as is a negative
 * gap (clock skew between the two events is not a measurement).
 */
function startGapCte(org: SQL, scope: FlowScope): SQL {
  return sql`
    SELECT x.started_at, EXTRACT(EPOCH FROM (x.first_stage - x.started_at)) AS gap_s
    FROM (
      SELECT pe.execution_id, MIN(pe.started_at) AS started_at,
             (SELECT MIN(s.started_at) FROM pipeline_events s
              WHERE s.pipeline_id = pe.pipeline_id AND s.execution_id = pe.execution_id
                AND s.event_type = 'STAGE' AND s.status = 'STARTED') AS first_stage
      FROM pipeline_events pe
      JOIN pipelines p ON p.id = pe.pipeline_id
      WHERE p.org_id ${org} AND pe.event_type = 'PIPELINE' AND pe.status = 'STARTED'
        AND pe.execution_id IS NOT NULL
      GROUP BY pe.pipeline_id, pe.execution_id
    ) x
    WHERE x.first_stage IS NOT NULL AND x.first_stage >= x.started_at
      AND ${inWindow(sql`x.started_at`, scope)}`;
}

const queueCols = sql`COUNT(*)::int AS builds, COUNT(queue_s)::int AS queue_n, COUNT(prov_s)::int AS prov_n,
       ${pct(sql`queue_s`, 'queue')}, ${pct(sql`prov_s`, 'prov')}`;

function queueFigures(r: Record<string, unknown>) {
  const qn = num(r.queue_n);
  const pn = num(r.prov_n);
  return {
    queueMedianSeconds: qn > 0 ? secOrNull(r.queue_median) : null,
    queueP90Seconds: qn > 0 ? secOrNull(r.queue_p90) : null,
    provisioningMedianSeconds: pn > 0 ? secOrNull(r.prov_median) : null,
    provisioningP90Seconds: pn > 0 ? secOrNull(r.prov_p90) : null,
  };
}

/**
 * Queue and provisioning time — the current figures: overall, by compute size,
 * the actions with the longest waits, and pipeline start → first stage. Free
 * (`reports:read`); the per-bucket series is {@link getQueueWaitTrend}.
 */
export async function getQueueWaits(scope: FlowScope): Promise<QueueWaitReport> {
  return securityRead(scope, async (org, tx) => {
    const b = buildsCte(org, scope);
    const totalsRes = await tx.execute(sql`WITH b AS (${b}) SELECT ${queueCols} FROM b`);
    const byTypeRes = await tx.execute(sql`
      WITH b AS (${b})
      SELECT compute_key, ${queueCols} FROM b
      GROUP BY compute_key ORDER BY builds DESC, compute_key`);
    const actionsRes = await tx.execute(sql`
      WITH b AS (${b})
      SELECT pipeline_id, MAX(pipeline_name) AS pipeline_name, stage_name, action_name, ${queueCols},
             percentile_cont(0.9) WITHIN GROUP (ORDER BY COALESCE(queue_s, 0) + COALESCE(prov_s, 0)) AS total_p90
      FROM b
      GROUP BY pipeline_id, stage_name, action_name
      ORDER BY total_p90 DESC NULLS LAST, builds DESC, stage_name, action_name
      LIMIT ${LIST_LIMIT}`);
    const gapRes = await tx.execute(sql`
      WITH g AS (${startGapCte(org, scope)})
      SELECT COUNT(*)::int AS n, ${pct(sql`gap_s`, 'gap')} FROM g`);

    const t = resultRows<Record<string, unknown>>(totalsRes)[0] ?? {};
    const g = resultRows<Record<string, unknown>>(gapRes)[0] ?? {};
    const tf = queueFigures(t);
    const gn = num(g.n);
    return {
      window: { from: scope.from, to: scope.to },
      builds: num(t.builds),
      queue: { n: num(t.queue_n), medianSeconds: tf.queueMedianSeconds, p90Seconds: tf.queueP90Seconds },
      provisioning: { n: num(t.prov_n), medianSeconds: tf.provisioningMedianSeconds, p90Seconds: tf.provisioningP90Seconds },
      byComputeType: resultRows<Record<string, unknown>>(byTypeRes).map((r) => {
        const key = String(r.compute_key);
        return {
          computeType: key === 'unknown' ? key : (normalizeComputeType(key) ?? key),
          builds: num(r.builds),
          ...queueFigures(r),
        };
      }),
      slowestActions: resultRows<Record<string, unknown>>(actionsRes).map((r) => ({
        pipelineId: String(r.pipeline_id),
        pipelineName: (r.pipeline_name as string | null) ?? null,
        stageName: (r.stage_name as string | null) ?? null,
        actionName: (r.action_name as string | null) ?? null,
        builds: num(r.builds),
        ...queueFigures(r),
        totalWaitP90Seconds: secOrNull(r.total_p90),
      })),
      startToFirstStage: {
        n: gn,
        medianSeconds: gn > 0 ? secOrNull(g.gap_median) : null,
        p90Seconds: gn > 0 ? secOrNull(g.gap_p90) : null,
      },
    };
  });
}

/**
 * The queue-time series: median / p90 queue and provisioning time per bucket,
 * and pipeline start → first stage per bucket. `advanced_reporting`.
 */
export async function getQueueWaitTrend(scope: FlowScope, bucket: FlowBucket): Promise<QueueTrendPoint[]> {
  assertReportInterval(bucket.interval);
  const tz = safeTz(bucket.tz);
  const weekStart = bucket.weekStart ?? 'monday';
  return securityRead(scope, async (org, tx) => {
    const res = await tx.execute(sql`
      WITH b AS (${buildsCte(org, scope)}),
      s AS ${bucketSeries(bucket.interval, scope.from, scope.to, tz, weekStart)},
      q AS (
        SELECT ${periodBucket(bucket.interval, sql`completed_at`, tz, weekStart)}::text AS period, ${queueCols}
        FROM b GROUP BY 1),
      g AS (
        SELECT ${periodBucket(bucket.interval, sql`started_at`, tz, weekStart)}::text AS period,
               COUNT(*)::int AS executions, ${pct(sql`gap_s`, 'gap')}
        FROM (${startGapCte(org, scope)}) x GROUP BY 1)
      SELECT s.period, COALESCE(q.builds, 0)::int AS builds,
             COALESCE(q.queue_n, 0)::int AS queue_n, COALESCE(q.prov_n, 0)::int AS prov_n,
             q.queue_median, q.queue_p90, q.prov_median, q.prov_p90,
             COALESCE(g.executions, 0)::int AS executions, g.gap_median, g.gap_p90
      FROM s LEFT JOIN q ON q.period = s.period LEFT JOIN g ON g.period = s.period
      ORDER BY s.period`);
    return resultRows<Record<string, unknown>>(res).map((r) => {
      const executions = num(r.executions);
      return {
        period: String(r.period),
        builds: num(r.builds),
        ...queueFigures(r),
        executions,
        startToFirstStageMedianSeconds: executions > 0 ? secOrNull(r.gap_median) : null,
        startToFirstStageP90Seconds: executions > 0 ? secOrNull(r.gap_p90) : null,
      };
    });
  });
}
