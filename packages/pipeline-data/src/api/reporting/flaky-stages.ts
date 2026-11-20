// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Flaky stages: a stage that FAILED and then PASSED on retry inside the same
 * execution.
 *
 * No new column is needed. A retried CodePipeline stage reopens the SAME
 * execution — AWS sends a terminal FAILED, then RESUMED, then a second terminal
 * status — and the reports already tell the two apart: {@link notOvertaken} is
 * true only for the row nothing later replaced. So, per (pipeline, execution,
 * stage):
 *
 *  - an OVERTAKEN FAILED row means the stage failed and was retried (the RESUMED
 *    row may be missing — an older ingest refused it — but a later terminal row
 *    overtakes the FAILED on its own, which is the same signal the execution
 *    list's `retried` flag reads), and
 *  - a STANDING SUCCEEDED row means the retry passed.
 *
 * Both together is a flake. The rate is flaky executions over the executions in
 * which the stage reached an outcome at all.
 *
 * Read from raw events, not the daily rollup: the rollup keeps each run's FINAL
 * outcome per stage, which is exactly the information a flake erases.
 */

import { sql, type SQL } from 'drizzle-orm';
import { orgScope, runReport } from './query-scope.js';
import { assertReportInterval, bucketKey, notOvertaken, periodBucket, startedAtWindow } from './sql-helpers.js';
import type { BucketOptions, FlakyStage, FlakyStageTrendPoint } from './types.js';
import { schema } from '../../database/drizzle-schema.js';
import { resultRows } from '../../database/pg-result.js';
import { withTenantTx } from '../../database/tenancy.js';

/**
 * One row per (pipeline, execution, stage) that reached an outcome, flagged
 * `flaky` when it failed, was retried and passed. `first_started` is the
 * stage's first attempt, which the trend buckets on and the window filters on.
 */
function stageExecutionsCte(pred: SQL, from: string, to: string, filter: SQL): SQL {
  return sql`
      stage_rows AS (
        SELECT e.pipeline_id AS pipeline_id, p.pipeline_name AS pipeline_name,
               e.execution_id AS execution_id, e.stage_name AS stage_name,
               e.status AS status, e.started_at AS started_at, e.completed_at AS completed_at,
               ${notOvertaken} AS standing
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'STAGE'
          AND e.stage_name IS NOT NULL AND e.execution_id IS NOT NULL
          AND e.status IN ('SUCCEEDED', 'FAILED')
          AND ${startedAtWindow(from, to)}
          ${filter}
      ),
      per_exec AS (
        SELECT pipeline_id, pipeline_name, stage_name, execution_id,
               (bool_or(status = 'FAILED' AND NOT standing) AND bool_or(status = 'SUCCEEDED' AND standing)) AS flaky,
               MIN(started_at) AS first_started,
               MAX(completed_at) AS last_completed
        FROM stage_rows
        GROUP BY pipeline_id, pipeline_name, stage_name, execution_id
      )`;
}

/** Optional (pipeline, stage) narrowing for the trend's drill-down. */
function scopeFilter(opts: { pipelineId?: string; stageName?: string }): SQL {
  const parts: SQL[] = [];
  if (opts.pipelineId) parts.push(sql`AND e.pipeline_id = ${opts.pipelineId}`);
  if (opts.stageName) parts.push(sql`AND e.stage_name = ${opts.stageName}`);
  return parts.length > 0 ? sql.join(parts, sql` `) : sql``;
}

/**
 * The ranked list: every (pipeline, stage) that flaked at least once in the
 * window, most flaky executions first. Org-scoped (`p.org_id ${pred}`) and
 * rollup-aware like the sibling execution reports.
 */
export async function getFlakyStages(
  orgId: string, from: string, to: string, orgIds?: string[], limit: number = 50,
): Promise<FlakyStage[]> {
  const { pred, multi } = orgScope(orgId, orgIds);
  const query = sql`
      WITH ${stageExecutionsCte(pred, from, to, sql``)},
      -- The actions whose FAILED a retry overtook, inside a flaky stage execution:
      -- "which step was it" is the first thing anyone fixing a flake asks.
      action_flakes AS (
        SELECT DISTINCT e.pipeline_id AS pipeline_id, e.stage_name AS stage_name, e.action_name AS action_name
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        JOIN per_exec x ON x.pipeline_id = e.pipeline_id AND x.stage_name = e.stage_name
          AND x.execution_id = e.execution_id AND x.flaky
        WHERE p.org_id ${pred} AND e.event_type = 'ACTION' AND e.status = 'FAILED'
          AND e.action_name IS NOT NULL
          AND ${startedAtWindow(from, to)}
          AND NOT ${notOvertaken}
      )
      SELECT
        x.pipeline_id::text AS pipeline_id,
        x.pipeline_name AS pipeline_name,
        x.stage_name AS stage_name,
        COUNT(*) FILTER (WHERE x.flaky)::int AS flaky_runs,
        COUNT(*)::int AS runs,
        ROUND(COUNT(*) FILTER (WHERE x.flaky)::numeric / NULLIF(COUNT(*), 0) * 100, 1)::float AS flake_pct,
        COALESCE((
          SELECT array_agg(a.action_name ORDER BY a.action_name)
          FROM action_flakes a
          WHERE a.pipeline_id = x.pipeline_id AND a.stage_name = x.stage_name
        ), ARRAY[]::text[]) AS flaky_actions,
        MAX(x.last_completed) FILTER (WHERE x.flaky)::text AS last_flaked
      FROM per_exec x
      GROUP BY x.pipeline_id, x.pipeline_name, x.stage_name
      HAVING COUNT(*) FILTER (WHERE x.flaky) > 0
      ORDER BY flaky_runs DESC, flake_pct DESC, x.pipeline_name, x.stage_name
      LIMIT ${limit}`;
  const exec = () => withTenantTx((tx) => tx.execute(query)).then((r) => resultRows<FlakyStage>(r));
  return runReport(`${orgId}:flaky-stages:${from}:${to}:${limit}`, multi, exec);
}

/**
 * The flake rate per time bucket — every stage of the scope together, or one
 * (pipeline, stage) when narrowed — in the report's timezone and week start.
 * Buckets on the stage's FIRST attempt, so a flake lands in the bucket it began
 * in. Summed over the buckets, `flaky_runs` equals the list's total for the same
 * window and scope.
 */
export async function getFlakyStageTrend(
  orgId: string, interval: string, from: string, to: string, orgIds?: string[],
  opts: BucketOptions & { pipelineId?: string; stageName?: string } = {},
): Promise<FlakyStageTrendPoint[]> {
  assertReportInterval(interval);
  const { pred, multi } = orgScope(orgId, orgIds);
  const { tz = 'UTC', weekStart = 'monday', pipelineId, stageName } = opts;
  const query = sql`
      WITH ${stageExecutionsCte(pred, from, to, scopeFilter({ pipelineId, stageName }))}
      SELECT
        ${periodBucket(interval, sql`x.first_started`, tz, weekStart)}::text AS period,
        COUNT(*) FILTER (WHERE x.flaky)::int AS flaky_runs,
        COUNT(*)::int AS runs,
        ROUND(COUNT(*) FILTER (WHERE x.flaky)::numeric / NULLIF(COUNT(*), 0) * 100, 1)::float AS flake_pct
      FROM per_exec x
      GROUP BY period
      ORDER BY period`;
  const exec = () => withTenantTx((tx) => tx.execute(query)).then((r) => resultRows<FlakyStageTrendPoint>(r));
  const key = `${orgId}:flaky-trend:${interval}:${from}:${to}:${pipelineId ?? ''}:${stageName ?? ''}:${bucketKey(tz, weekStart)}`;
  return runReport(key, multi, exec);
}
