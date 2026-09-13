// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Retention windows for reporting data: env-configurable, clamped to a sane
 * range, and overridable per-org by the settings row.
 */

/**
 * Reporting retention windows (Phase 7). Records in `pipeline_events`,
 * `deployment_outcomes`, and `incidents` grow unbounded without a sweep, so a
 * split, per-org retention purge (see {@link ReportingService.purgeExpiredReportingData})
 * hard-deletes rows older than these windows, by `created_at`:
 *  - **Standard events** — `pipeline_events` with `environment IS NULL`
 *    (non-deploy STAGE/ACTION/build). High volume → short default (30 days).
 *  - **DORA source** — `pipeline_events` with `environment IS NOT NULL` (deploy
 *    stages) plus all of `deployment_outcomes` and `incidents`. Low volume →
 *    longer default (180 days). DORA history is therefore bounded by this window;
 *    the report query still hard-caps at 365 days (a longer per-org override only
 *    retains raw source rows, never widens a report).
 * `ingest_health` and `dora_settings` are never purged. Env-overridable globals;
 * a per-org override in `dora_settings` wins (see {@link resolveEventRetentionDays}).
 */
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 730;

/** Parse a positive-int env day-count, clamped to [MIN, MAX], else `fallback`. */
export function retentionEnvDays(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < RETENTION_MIN_DAYS) return fallback;
  return Math.min(raw, RETENTION_MAX_DAYS);
}

export const REPORTING_EVENT_RETENTION_DAYS = retentionEnvDays('REPORTING_EVENT_RETENTION_DAYS', 30);
export const REPORTING_DORA_RETENTION_DAYS = retentionEnvDays('REPORTING_DORA_RETENTION_DAYS', 180);

/** Effective standard-event retention (days): a valid per-org override wins,
 *  else the global env default. Shared by the sweep + the settings surface so
 *  they can't drift. The `-1` unlimited sentinel (Phase 8) passes straight
 *  through — the sweep reads it as "keep forever, skip this org's standard
 *  events". A positive override clamps to [1, RETENTION_MAX_DAYS]; a `null`, a
 *  non-integer, or any other out-of-range value (e.g. 0, -2) falls back to the
 *  env default. */
export function resolveEventRetentionDays(override?: number | null): number {
  if (override === -1) return -1;
  return override != null && Number.isInteger(override) && override >= RETENTION_MIN_DAYS
    ? Math.min(override, RETENTION_MAX_DAYS) : REPORTING_EVENT_RETENTION_DAYS;
}

/** Effective DORA-source retention (days): a valid per-org override wins, else
 *  the global env default. The `-1` unlimited sentinel (Phase 8) passes straight
 *  through — the sweep reads it as "keep forever, skip this org's DORA-source
 *  windows". A positive override clamps to [1, RETENTION_MAX_DAYS]; a `null`, a
 *  non-integer, or any other out-of-range value (e.g. 0, -2) falls back to the
 *  env default. */
export function resolveDoraRetentionDays(override?: number | null): number {
  if (override === -1) return -1;
  return override != null && Number.isInteger(override) && override >= RETENTION_MIN_DAYS
    ? Math.min(override, RETENTION_MAX_DAYS) : REPORTING_DORA_RETENTION_DAYS;
}

/** The cutoff instant for a retention window: rows with `created_at` strictly
 *  before this (`< cutoff`) are expired. Deterministic for a fixed `now`. */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** Per-org retention override row (Phase 7). Both nullable ⇒ global defaults. */
