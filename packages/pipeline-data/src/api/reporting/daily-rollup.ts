// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Building `execution_daily_rollups` from events.
 *
 * Every section that says "runs", "success rate", "p95" or "build minutes" reads
 * these rows, so a quarterly report over a busy org costs a few hundred rows
 * instead of a few hundred thousand — and keeps working after retention has swept
 * the events it was built from.
 *
 * TWO PROPERTIES THE JOB HAS TO HAVE, and both shape the code:
 *
 *  - IDEMPOTENT PER DAY. A day is recomputed WHOLESALE and upserted, never
 *    incremented. Incrementing is how a redelivered event, a retried tick or a
 *    crashed half-run silently inflates a count, and an inflated success rate is
 *    worse than a missing one because nobody can tell.
 *  - REBUILDS A DAY WHEN LATE EVENTS ARRIVE. The ingest's dead-letter queue is
 *    redriven hours later, so yesterday's numbers legitimately change. The
 *    `computed_at` stamp is what makes that visible rather than mysterious.
 *
 * THE SETTLE DELAY lives here too: a day is only rolled up once it has been closed
 * long enough for in-flight executions to finish. Rolling up a day at 00:01 counts
 * every execution still running at midnight as neither a success nor a failure.
 */

import { createLogger, errorMessage, envInt, startOf } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { failedStatusList, nonOutcomeStatusList, notOvertaken, succeededStatusList } from './sql-helpers.js';
import { affectedRowCount } from '../../database/pg-result.js';
import { runWithTenantContext, withTenantTx } from '../../database/tenancy.js';

const logger = createLogger('daily-rollup');

/**
 * How long after a day closes before it is rolled up (hours).
 *
 * Six by default, matching the report scheduler's own settle delay: both exist for
 * the same reason, and a rollup that lagged the report would make a scheduled
 * report read a half-built day.
 */
export function rollupSettleHours(): number {
  return envInt('REPORTING_ROLLUP_SETTLE_HOURS', 6, { min: 0 });
}

/** Rows per rebuild pass. Bounds the statement, not the backlog. */
export function rollupBatchDays(): number {
  return envInt('REPORTING_ROLLUP_BATCH_DAYS', 7, { min: 1 });
}

/**
 * Rebuild the rollup rows for one UTC day, for every org that had activity.
 *
 * ONE statement, computed entirely in Postgres. Deliberately not "select the
 * events, aggregate in Node, write the rows": the whole point of the rollup is to
 * avoid moving a day's events across the wire, and a job that did it to BUILD the
 * rollup would just move the cost rather than remove it.
 *
 * Percentiles use `PERCENTILE_CONT`, which is the same function the on-demand
 * queries use — so a rollup-backed number and a live number agree rather than
 * differing by an interpolation rule.
 */
export async function rebuildDay(day: Date): Promise<number> {
  const dayStart = startOf(day, 'day');
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);

  // TWO GRAINS, one scan, and no GROUPING SETS needed: a PIPELINE event carries
  // no stage name, so it collapses to the `''` pipeline-level row, and a STAGE
  // event lands on its own stage row. The event shape gives the hierarchy for
  // free.
  //
  // CTEs rather than window functions, because `PERCENTILE_CONT` is an ordered-set
  // aggregate and cannot be used as a window function at all — the shape that
  // looks natural here does not run.
  //
  // ONE ROW PER OUTCOME, not per event. A STARTED or RESUMED row is a lifecycle
  // step of a run that has (or will have) its own terminal row, and a terminal row
  // a retry overtook (FAILED, then the retried stage SUCCEEDED) is not the run's
  // outcome — counting either made one run several.
  //
  // ELEVATED, because this is a SYSTEM job over every org's events: under any
  // narrower scope FORCE RLS on `pipeline_events` / `execution_daily_rollups`
  // hides the other orgs' rows, and with no scope at all the GUCs are empty and
  // the statement silently rolls up NOTHING (or throws, in production's strict
  // RLS_CONTEXT_MODE — which `runRollupPass` would then swallow as a warning
  // every day). The elevation lives here rather than in a caller so no scheduler
  // can forget it; there is no per-org variant to protect.
  const result = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => tx.execute(sql`
    WITH ev AS (
      SELECT
        e.org_id,
        e.pipeline_id::text AS pipeline_id,
        COALESCE(e.stage_name, '') AS stage_name,
        e.status,
        e.failure_category,
        e.duration_ms
      FROM pipeline_events e
      WHERE e.created_at >= ${dayStart} AND e.created_at < ${dayEnd}
        AND e.pipeline_id IS NOT NULL
        AND e.event_type IN ('PIPELINE', 'STAGE')
        AND e.status NOT IN (${nonOutcomeStatusList})
        AND ${notOvertaken}
    ),
    cats AS (
      SELECT org_id, pipeline_id, stage_name,
             jsonb_object_agg(failure_category, n) AS failures_by_category
      FROM (
        SELECT org_id, pipeline_id, stage_name, failure_category, COUNT(*)::int AS n
        FROM ev
        WHERE failure_category IS NOT NULL
        GROUP BY 1, 2, 3, 4
      ) t
      GROUP BY 1, 2, 3
    ),
    agg AS (
      SELECT
        org_id, pipeline_id, stage_name,
        COUNT(*)::int AS runs,
        COUNT(*) FILTER (WHERE status IN (${succeededStatusList}))::int AS succeeded,
        COUNT(*) FILTER (WHERE status IN (${failedStatusList}))::int AS failed,
        -- NULL durations are ignored by PERCENTILE_CONT, which is what we want: an
        -- event with no duration has no timing to contribute, and treating it as
        -- zero would drag every percentile down.
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50_ms,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duration_ms)::int AS p90_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
        (SUM(COALESCE(duration_ms, 0)) / 1000)::int AS build_seconds
      FROM ev
      GROUP BY 1, 2, 3
    )
    INSERT INTO execution_daily_rollups (
      org_id, day, pipeline_id, stage_name,
      runs, succeeded, failed, failures_by_category,
      p50_ms, p90_ms, p95_ms, build_seconds, computed_at
    )
    SELECT
      a.org_id, ${dayStart}::timestamptz, a.pipeline_id, a.stage_name,
      a.runs, a.succeeded, a.failed,
      COALESCE(c.failures_by_category, '{}'::jsonb),
      a.p50_ms, a.p90_ms, a.p95_ms, a.build_seconds, NOW()
    FROM agg a
    LEFT JOIN cats c
      ON c.org_id = a.org_id AND c.pipeline_id = a.pipeline_id AND c.stage_name = a.stage_name
    ON CONFLICT (org_id, day, pipeline_id, stage_name) DO UPDATE SET
      runs = excluded.runs,
      succeeded = excluded.succeeded,
      failed = excluded.failed,
      failures_by_category = excluded.failures_by_category,
      p50_ms = excluded.p50_ms,
      p90_ms = excluded.p90_ms,
      p95_ms = excluded.p95_ms,
      build_seconds = excluded.build_seconds,
      computed_at = excluded.computed_at
  `)));
  const rows = affectedRowCount(result);
  logger.debug('Rolled up a day', { day: dayStart.toISOString().slice(0, 10), rows });
  return rows;
}

/**
 * One rollup pass: rebuild a window of recent days, newest first.
 *
 * THE NEWEST DAY MAY STILL BE OPEN, deliberately. The window ends at the day that
 * contains `now - settle`, so for the last `settle` hours of each UTC day the
 * pass rebuilds that still-running day too. Live analytics then show today's
 * numbers (partial, refreshed every pass) instead of nothing until 06:00
 * tomorrow. Scheduled reports are unaffected: they only read CLOSED periods,
 * composed `REPORT_SETTLE_HOURS` after the period ends, by which time every pass
 * since has rebuilt that day with all of it present. A day is FINAL once
 * `now - settle` has moved past its end and the window has re-covered it.
 *
 * Rebuilding a WINDOW rather than only the newest day is what handles late
 * events: the dead-letter redrive lands events for days already rolled up, and a
 * job that only ever built "yesterday" would leave those days permanently wrong.
 * Recomputing a week costs one statement per day and makes lateness self-healing
 * instead of a support question.
 *
 * Never throws — the caller is a scheduler tick, and a failed pass must retry next
 * tick rather than take the service's background work down with it.
 */
export async function runRollupPass(now: Date = new Date()): Promise<{ days: number; rows: number }> {
  const settleMs = rollupSettleHours() * 3600_000;
  // The day containing `now - settle` — possibly the still-open day (see the doc
  // comment): fresh live numbers now, finalized once the settle window passes.
  const newest = startOf(new Date(now.getTime() - settleMs), 'day');
  let rows = 0;
  let days = 0;
  for (let i = 0; i < rollupBatchDays(); i++) {
    const day = new Date(newest.getTime() - i * 24 * 3600_000);
    try {
      rows += await rebuildDay(day);
      days++;
    } catch (err) {
      logger.warn('Rollup pass failed for a day; it will be retried next pass', {
        day: day.toISOString().slice(0, 10),
        error: errorMessage(err),
      });
    }
  }
  return { days, rows };
}
