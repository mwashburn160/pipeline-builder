// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Small SQL fragments and input guards shared across the reporting queries.
 */

import { REPORT_INTERVALS, scrubAwsIdentifiersFromString } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';

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
 */
export const terminalStatusRollup = sql`CASE
              WHEN bool_or(e.status = 'FAILED') THEN 'FAILED'
              WHEN bool_or(e.status = 'SUCCEEDED') THEN 'SUCCEEDED'
              ELSE 'OTHER'
            END`;

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
