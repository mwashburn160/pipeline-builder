// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of automatic tidying: given one version's clock, its tidy
 * state and the first protection that holds it (facts.ts), what the daily job
 * does with it today. The preview and the run call this same function, so the
 * dry run is the run.
 */

import { DAY_MS, TIDY_RETIRE_AFTER_DAYS, TIDY_WARN_DAYS } from './config.js';
import type { AutoTidyMode } from './settings.js';

/**
 * Why tidying leaves a version alone (the first that holds, in this order).
 * Bounded: these are `plugin_tidy_skipped_total{reason}`'s only values.
 */
export const TIDY_SKIP_REASONS = [
  'managed', 'never_tidy', 'only_version', 'inactive_by_owner', 'default', 'latest', 'frozen',
  'remediation_pending', 'install_pin', 'listed_in_use', 'kev_accepted', 'in_use',
] as const;
export type TidySkipReason = typeof TIDY_SKIP_REASONS[number];

/**
 * What the job does with a version today:
 *  - `fresh` — not within a week of going stale (absent from the report);
 *  - `warn` — within a week of stale (or past it) and not warned: listed in today's digest;
 *  - `warn_queued` — as `warn`, but the org had a digest this week: it waits for the next one;
 *  - `warned` — in a digest already; waiting for its deactivation date (or, in notify mode, for ever);
 *  - `deactivate` — on mode, deactivation date reached: deactivated today;
 *  - `deactivated` — tidying deactivated it; waiting out the 30 days to retirement;
 *  - `retire` — on mode, deactivated 30 days and still unused: soft-deleted today;
 *  - `skipped` — a protection holds it (`reason`), and it would otherwise be stale;
 *  - `reactivate` — tidying deactivated it, but now a protection holds it (or its clock restarted): active again;
 *  - `clear` — warned, but now protected or fresh: the warning is dropped.
 */
export type TidyState = 'fresh' | 'warn' | 'warn_queued' | 'warned' | 'deactivate' | 'deactivated' | 'retire' | 'skipped' | 'reactivate' | 'clear';

/** One version's clock and tidy state. */
export interface TidyClock {
  createdAt: Date;
  lastUsedAt: Date | null;
  keptAt: Date | null;
  warnedAt: Date | null;
  deactivateAfter: Date | null;
  deactivatedAt: Date | null;
}

export interface TidyDecision {
  state: TidyState;
  reason?: TidySkipReason;
  /** N: the day the version goes stale. */
  staleAt: Date;
  /** The day it is (or would be) deactivated. */
  deactivateAt?: Date;
  /** The day it is (or would be) retired. */
  retireAt?: Date;
}

const later = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);
const plusDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);

/** The day the version goes stale: the latest of created / last used / kept, plus `staleAfterDays`. */
export function staleAt(clock: TidyClock, staleAfterDays: number): Date {
  let anchor = clock.createdAt;
  if (clock.lastUsedAt) anchor = later(anchor, clock.lastUsedAt);
  if (clock.keptAt) anchor = later(anchor, clock.keptAt);
  return plusDays(anchor, staleAfterDays);
}

/**
 * Decide one version. `protection` is the first reason that holds it (or
 * null); `nextDigestAt` is when the org's next digest may go out (≤ now when
 * one may go out today).
 */
export function decideTidy(input: {
  clock: TidyClock;
  protection: TidySkipReason | null;
  mode: Exclude<AutoTidyMode, 'off'>;
  staleAfterDays: number;
  now: Date;
  nextDigestAt: Date;
}): TidyDecision {
  const { clock, protection, mode, now } = input;
  const stale = staleAt(clock, input.staleAfterDays);
  const warnFrom = plusDays(stale, -TIDY_WARN_DAYS);
  const timeEligible = now.getTime() >= warnFrom.getTime();

  if (clock.deactivatedAt) {
    if (protection) return { state: 'reactivate', reason: protection, staleAt: stale };
    if (!timeEligible) return { state: 'reactivate', staleAt: stale };
    const retireAt = plusDays(clock.deactivatedAt, TIDY_RETIRE_AFTER_DAYS);
    return { state: mode === 'on' && now.getTime() >= retireAt.getTime() ? 'retire' : 'deactivated', staleAt: stale, deactivateAt: clock.deactivatedAt, retireAt };
  }
  if (protection) {
    if (clock.warnedAt) return { state: 'clear', reason: protection, staleAt: stale };
    return timeEligible ? { state: 'skipped', reason: protection, staleAt: stale } : { state: 'fresh', staleAt: stale };
  }
  if (!timeEligible) return { state: clock.warnedAt ? 'clear' : 'fresh', staleAt: stale };
  if (!clock.warnedAt) {
    const digestToday = now.getTime() >= input.nextDigestAt.getTime();
    const warnDay = digestToday ? now : input.nextDigestAt;
    const deactivateAt = later(stale, plusDays(warnDay, TIDY_WARN_DAYS));
    return { state: digestToday ? 'warn' : 'warn_queued', staleAt: stale, deactivateAt, retireAt: plusDays(deactivateAt, TIDY_RETIRE_AFTER_DAYS) };
  }
  const deactivateAt = clock.deactivateAfter ?? later(stale, plusDays(clock.warnedAt, TIDY_WARN_DAYS));
  const due = mode === 'on' && now.getTime() >= deactivateAt.getTime();
  return { state: due ? 'deactivate' : 'warned', staleAt: stale, deactivateAt, retireAt: plusDays(due ? now : deactivateAt, TIDY_RETIRE_AFTER_DAYS) };
}
