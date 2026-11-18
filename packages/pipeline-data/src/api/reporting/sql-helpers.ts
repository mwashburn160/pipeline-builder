// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Small SQL fragments and input guards shared across the reporting queries.
 */

import { REPORT_INTERVALS, scrubAwsIdentifiersFromString, type WeekStart } from '@pipeline-builder/api-core';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Defense-in-depth guard for the `DATE_TRUNC(${interval}, …)` bucket argument.
 * The route layer (`parseReportInterval`) is the security boundary and already
 * rejects unknown intervals; this assert makes an invalid value fail fast at the
 * service boundary with a clear error instead of surfacing a raw Postgres error
 * if a caller ever bypasses the route validation. Shares api-core's
 * REPORT_INTERVALS allow-list so the two can't drift.
 */
export function assertReportInterval(interval: string): void {
  if (!(REPORT_INTERVALS as readonly string[]).includes(interval)) {
    throw new Error(`Invalid report interval: ${interval}. Expected one of: ${REPORT_INTERVALS.join(', ')}`);
  }
}

/**
 * The time-bucket expression for a report series: `DATE_TRUNC` in the REPORT'S
 * timezone, honouring the org's week start.
 *
 * Two things this fixes, both of which made a manager's report cover the wrong
 * days:
 *
 *  - Bucketing ran in the database session's timezone, which is UTC in every
 *    deploy. A Chicago team's "week" therefore began 18:00 Sunday local, so their
 *    Monday report cut off Sunday evening's work and attributed it to the previous
 *    week. `AT TIME ZONE` converts to local wall time BEFORE truncating.
 *  - Postgres `DATE_TRUNC('week', …)` is ISO-8601 and always starts Monday, with
 *    no setting. A Sunday-week org gets the boundary shifted a day either side of
 *    the truncation, which is the only way to move it.
 *
 * `interval` is asserted against the allow-list by {@link assertReportInterval};
 * `tz` rides as a BOUND parameter, never interpolated.
 *
 * Returns a `timestamp without time zone` in local wall time — which is what a
 * period label ("2026-W38", "2026-08") should read as.
 */
export function periodBucket(interval: string, column: SQL, tz: string, weekStart: WeekStart = 'monday'): SQL {
  assertReportInterval(interval);
  const local = sql`(${column} AT TIME ZONE ${tz})`;
  if (interval === 'week' && weekStart === 'sunday') {
    return sql`(DATE_TRUNC('week', ${local} + INTERVAL '1 day') - INTERVAL '1 day')`;
  }
  return sql`DATE_TRUNC(${interval}, ${local})`;
}

/**
 * Cache-key suffix for the bucketing settings. Report cache keys carried the
 * interval and the date range but NOT the timezone or week start, so once
 * bucketing became timezone-aware one org's Chicago buckets would have been
 * served to a request asking for UTC. Every keyed report must include this.
 */
export function bucketKey(tz: string, weekStart: WeekStart = 'monday'): string {
  return `${tz}:${weekStart}`;
}

/**
 * Scrub AWS identifiers from an optional free-form string, preserving `undefined`
 * (so an absent field stays absent rather than becoming an empty scrubbed string).
 * The DURABLE persistence boundary for the ingest paths — every user/AWS-derived
 * string field is funneled through this before insert.
 */
export function scrubOptional(value: string | undefined): string | undefined {
  return value !== undefined ? scrubAwsIdentifiersFromString(value) : undefined;
}

/**
 * Roll a group of deploy/stage events (grouped per execution) up to one terminal
 * status: FAILED wins, then SUCCEEDED, else OTHER (still-running / non-terminal).
 * Shared by the three per-(env|stage, execution) rollup CTEs — DORA metrics, DORA
 * trend, and build health — so the precedence can't drift between them. Assumes the
 * grouped event alias is `e`.
 *
 * "FAILED wins" is right ACROSS the stages of an execution (two deploy stages to
 * one env, one failed: the deployment failed). It is wrong WITHIN one stage that
 * was retried, so each caller also filters on {@link notOvertaken}: the FAILED a
 * successful retry overtook never reaches this CASE.
 */
export const terminalStatusRollup = sql`CASE
              WHEN bool_or(e.status = 'FAILED') THEN 'FAILED'
              WHEN bool_or(e.status = 'SUCCEEDED') THEN 'SUCCEEDED'
              ELSE 'OTHER'
            END`;

/**
 * The CodePipeline states that END an execution, stage or action. Mirrors the
 * events Lambda's `TERMINAL_STATES` (packages/pipeline-events/src/parse.ts):
 * these are the rows that carry a `completed_at`.
 */
export const TERMINAL_EVENT_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELED', 'STOPPED', 'SUPERSEDED', 'ABANDONED'] as const;

/** {@link TERMINAL_EVENT_STATUSES} as a SQL list, for `status IN (…)`. */
export const terminalStatusList = sql.join(TERMINAL_EVENT_STATUSES.map((s) => sql`${s}`), sql`, `);

/**
 * Lifecycle states that are NOT an outcome: the run, stage or action is under way
 * (or re-opened) and a terminal row will follow. A report counting outcomes
 * excludes them.
 */
export const NON_OUTCOME_EVENT_STATUSES = ['STARTED', 'RESUMED', 'IN_PROGRESS', 'STOPPING'] as const;

/** {@link NON_OUTCOME_EVENT_STATUSES} as a SQL list, for `status NOT IN (…)`. */
export const nonOutcomeStatusList = sql.join(NON_OUTCOME_EVENT_STATUSES.map((s) => sql`${s}`), sql`, `);

/**
 * True for an event row that NO LATER terminal event of the same execution has
 * overtaken. Assumes the outer event alias is `e`.
 *
 * WHY. A retried CodePipeline stage reopens the SAME execution: AWS sends a
 * terminal `FAILED`, then `RESUMED`, then a second terminal status (say
 * `SUCCEEDED`) for the same execution, stage and action. Reports that read
 * "any FAILED" or count terminal rows then show one successful run as a failure,
 * or as two runs. The latest terminal status is the execution's outcome, so the
 * overtaken one is excluded.
 *
 * A terminal row is overtaken by a LATER row for the same unit that is either:
 *  - terminal (the retry finished: its outcome replaces this one), or
 *  - RESUMED (the retry is running: this outcome is no longer the answer, and
 *    the run reads as in progress until the retry finishes).
 *
 * "Same unit" = same execution, pipeline, event type, stage and action, so a
 * failed stage is only overtaken by that stage's own later rows, never by a
 * sibling stage. Ordered by AWS's event time (`completed_at` on a terminal row,
 * `started_at` on a RESUMED row — the events Lambda stamps the resume time
 * there), NOT by ingest time: a dead-letter redrive inserts events hours late and
 * out of order. A non-terminal row (no `completed_at`) and a row with no execution id
 * always pass. Served by `event_execution_id_idx`.
 */
export const notOvertaken = sql`NOT EXISTS (
            SELECT 1 FROM pipeline_events later
            WHERE later.execution_id = e.execution_id
              AND later.pipeline_id = e.pipeline_id
              AND later.event_type = e.event_type
              AND later.stage_name IS NOT DISTINCT FROM e.stage_name
              AND later.action_name IS NOT DISTINCT FROM e.action_name
              AND (
                (later.status IN (${terminalStatusList}) AND later.completed_at > e.completed_at)
                OR (later.status = 'RESUMED' AND later.started_at > e.completed_at)
              )
          )`;

/** The report window on `e.started_at` (inclusive `[from, to]`). */
export function startedAtWindow(from: string, to: string): ReturnType<typeof sql> {
  return sql`e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz`;
}

/** Optional `[from,to]` window on `e.started_at` for the execution reports —
 *  a no-op `sql` fragment when either bound is absent (all-time). Shared by the
 *  execution-count and per-pipeline-execution reports so they narrow identically. */
export function optionalStartedAtRange(range?: { from?: string; to?: string }): ReturnType<typeof sql> {
  return range?.from && range?.to
    ? sql`AND ${startedAtWindow(range.from, range.to)}`
    : sql``;
}

/**
 * Per-execution terminal deploy row (one row per (environment, execution),
 * NOT per stage). The SQL rolls every deploy STAGE targeting an env within an
 * execution up to a single terminal status; the JS shaping buckets these by
 * environment. `commit_ts` is the execution's EARLIEST commit time across
 * all its events — commit enrichment rides the PIPELINE/source event, not the
 * deploy STAGE — joined by execution_id (null when unresolved → lead `unknown`).
 * `in_window` is false for a look-back-only row kept solely so incidents opened
 * near `from` can correlate to a deploy that completed just before the window.
 */
