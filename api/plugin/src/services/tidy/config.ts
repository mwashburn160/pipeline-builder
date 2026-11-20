// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic plugin version tidying (docs/plugin-publishing.md "Automatic
 * tidying"): the operator switch and the fixed timeline, read in ONE place so
 * the preview, the daily job and the routes agree.
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `PLUGIN_AUTO_TIDY_ENABLED` | `true` | Run the daily tidy job. Only the literal `false` turns it off; the preview answers either way. |
 *
 * The timeline, counted from the day a version goes stale (N = the latest of
 * created / last used / kept + the org's `staleAfterDays`): warned at N-7 in the
 * org's weekly digest, deactivated at N (never sooner than 7 days after its
 * warning), retired (soft-deleted under a batch id, restorable) at N+30, and
 * purged by the existing soft-delete sweep 30 days later (N+60).
 */

import { envStr } from '@pipeline-builder/api-core';

export const DAY_MS = 86_400_000;
/** Days before N the owner is warned (and the least time between warning and deactivation). */
export const TIDY_WARN_DAYS = 7;
/** Days a tidy-deactivated version waits, still unused, before it is retired. */
export const TIDY_RETIRE_AFTER_DAYS = 30;
/** At most one digest per org per this many days. */
export const TIDY_DIGEST_INTERVAL_DAYS = 7;
/** `pluginRetention.staleAfterDays`: default and bounds. */
export const TIDY_STALE_DEFAULT_DAYS = 90;
export const TIDY_STALE_MIN_DAYS = 30;
export const TIDY_STALE_MAX_DAYS = 3650;
/** A version's `last_used_at` is written at most this often. */
export const TIDY_USE_THROTTLE_MS = 60 * 60_000;

/** Whether the operator lets the daily job run (`PLUGIN_AUTO_TIDY_ENABLED`; only the literal `false` disables). */
export function tidyOperatorEnabled(): boolean {
  return envStr('PLUGIN_AUTO_TIDY_ENABLED', 'true').trim() !== 'false';
}
