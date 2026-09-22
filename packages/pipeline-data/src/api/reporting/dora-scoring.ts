// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { DoraLevel } from './types.js';

/**
 * DORA performance banding plus the small statistics helpers it needs.
 * Pure functions — no database access, no I/O — which is what lets the
 * thresholds be unit-tested independently of the queries that feed them.
 */

/**
 * The DORA headline environment. Deployment to this literal env name is the
 * industry-standard DORA signal; MTTR is measured production-only, and this
 * environment's card is the summary shown at the top of the panel.
 */
export const HEADLINE_ENV = 'production';

/**
 * Incident→deploy correlation window. An incident is attributed to the
 * most recent SUCCESSFUL deploy to its environment whose `completed_at` is within
 * this many hours before the incident's `opened_at`. Default 24h; override via
 * `DORA_INCIDENT_WINDOW_HOURS`. Guarded to a positive finite number.
 */
export const DORA_INCIDENT_WINDOW_HOURS = (() => {
  const raw = Number(process.env.DORA_INCIDENT_WINDOW_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
})();

/**
 * Resolve the effective incident→deploy correlation window. A per-org
 * override (from `dora_settings.incident_window_hours`, surfaced through the
 * settings endpoint and threaded into {@link DoraOptions.incidentWindowHours})
 * wins when it is a positive finite number; otherwise the global env default
 * `DORA_INCIDENT_WINDOW_HOURS` applies. Centralized so the DORA correlation, the
 * incidents list, and the wiring-test dry-run all agree on the same rule.
 */
export function resolveIncidentWindowHours(override?: number | null): number {
  return override != null && Number.isFinite(override) && override > 0 ? override : DORA_INCIDENT_WINDOW_HOURS;
}

/**
 * Reporting retention windows. Records in `pipeline_events`,
 * `deployment_outcomes`, and `incidents` grow unbounded without a sweep, so a
 * split, per-org retention purge (see {@link ReportingService.purgeExpiredReportingData})
 * hard-deletes rows older than these windows, by `created_at`:
 *  - **Standard events** — `pipeline_events` with `environment IS NULL` and no
 *    `commit_timestamp` (non-deploy STAGE/ACTION/build). High volume → short
 *    default (30 days). A row that DOES carry a commit timestamp is DORA source
 *    data — lead time joins on it — so it follows the DORA window instead.
 *  - **DORA source** — `pipeline_events` with `environment IS NOT NULL` (deploy
 *    stages) plus all of `deployment_outcomes` and `incidents`. Low volume →
 *    longer default (180 days). DORA history is therefore bounded by this window;
 *    the report query still hard-caps at 365 days (a longer per-org override only
 *    retains raw source rows, never widens a report).
 * `ingest_health` and `dora_settings` are never purged. Env-overridable globals;
 * a per-org override in `dora_settings` wins (see {@link resolveEventRetentionDays}).
 */

/** Deployment frequency by deploys/day: elite ≥1/day, high ≥1/week, medium ≥1/month. */
export function doraLevelForFrequency(perDay: number, deployments: number): DoraLevel {
  if (deployments <= 0) return null;
  if (perDay >= 1) return 'elite';
  if (perDay >= 1 / 7) return 'high';
  if (perDay >= 1 / 30) return 'medium';
  return 'low';
}
/** Change failure rate by percent: elite ≤5%, high ≤10%, medium ≤15%. */
export function doraLevelForChangeFailure(pct: number, total: number): DoraLevel {
  if (total <= 0) return null;
  if (pct <= 5) return 'elite';
  if (pct <= 10) return 'high';
  if (pct <= 15) return 'medium';
  return 'low';
}
/** Time to restore by seconds: elite <1h, high <1 day, medium <1 week. */
export function doraLevelForRestore(avgSeconds: number | null): DoraLevel {
  if (avgSeconds == null) return null;
  if (avgSeconds < 3600) return 'elite';
  if (avgSeconds < 86400) return 'high';
  if (avgSeconds < 604800) return 'medium';
  return 'low';
}
/** Lead time by seconds: elite <1 day, high <1 week, medium <1 month. */
export function doraLevelForLeadTime(medianSeconds: number | null): DoraLevel {
  if (medianSeconds == null) return null;
  if (medianSeconds < 86400) return 'elite';
  if (medianSeconds < 604800) return 'high';
  if (medianSeconds < 2592000) return 'medium';
  return 'low';
}

/**
 * Round `value` to `digits` decimal places, returning a real number. Small
 * module-private helper so the DORA shaping doesn't repeat the
 * `Number(Number(x).toFixed(n))` pattern (toFixed alone yields a string).
 */
export function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/**
 * Median of a numeric sample, or `null` when empty. Used for measured lead time
 * and MTTR — both are cross-source gaps computed in JS from clamped deltas, so
 * the median lives here rather than in SQL PERCENTILE_CONT (keeps the golden
 * fixture tests able to prove the metric math without a live Postgres).
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Roll a group of deploy/stage events (grouped per execution) up to one terminal
 * status: FAILED wins, then SUCCEEDED, else OTHER (still-running / non-terminal).
 * Shared by the three per-(env|stage, execution) rollup CTEs — DORA metrics, DORA
 * trend, and build health — so the precedence can't drift between them. Assumes the
 * grouped event alias is `e`.
 */
