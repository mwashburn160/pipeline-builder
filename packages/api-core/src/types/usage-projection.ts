// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a quota counter is HEADED, from where it is now.
 *
 * Extracted out of `frontend/src/components/quotas/QuotaCard.tsx`, which owned
 * this privately (docs/plans/sales-agent.md, Phase 0 groundwork). Three callers
 * need the same answer and were going to compute it three ways:
 *
 *  - the quota card's forecast row, which is where it started;
 *  - the threshold notice, which decides whether to warn;
 *  - the usage profile's TRAJECTORY signal (D4 Class 2), which is the whole
 *    basis for "when will they run out" rather than "are they out".
 *
 * A projection that disagreed between the page and the offer would be the worst
 * possible split: the account reads one number on the card and gets an offer
 * argued from another.
 *
 * DEPENDENCY-FREE, so the browser imports it through the `./usage-projection`
 * subpath rather than keeping the copy it has now.
 */

/** Milliseconds in a day, named because the arithmetic below reads better for it. */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageProjection {
  /** Units the counter is pacing to reach by `resetAt`. */
  projected: number;
  /** `projected / limit`. Above 1 means the cap is reached before the reset. */
  ratio: number;
  /** Whether the pace exhausts the limit before the period ends. */
  willBreach: boolean;
  /** Fraction of the period already elapsed, 0–1. */
  elapsedFraction: number;
}

/**
 * Project a flow counter to its period end, or `null` when there is nothing to
 * project from.
 *
 * Returns null rather than zero for every unprojectable case — no usage yet, an
 * unlimited or absent limit, a period that has not started, an unparseable
 * reset — because zero is a FORECAST and "cannot say" is not one. A caller that
 * treated the two alike would warn an account at 0% and offer against a
 * trajectory nobody measured.
 *
 * The burn rate is LINEAR, and that is a deliberate floor rather than a model:
 * real workloads spike, but a straight line still catches "pacing three times
 * ahead of plan", which is the case worth acting on. Anything cleverer wants the
 * history the profile store keeps (D16), not a better formula here.
 */
export function projectUsage(input: {
  used: number;
  limit: number;
  resetAt: string | Date;
  periodDays: number;
  /** Defaults to now; injectable so a caller can project as of a period's end. */
  now?: number;
}): UsageProjection | null {
  const { used, limit, periodDays } = input;
  const reset = input.resetAt instanceof Date ? input.resetAt : new Date(input.resetAt);
  if (Number.isNaN(reset.getTime())) return null;
  // `limit <= 0` covers both an unset cap and the `-1` that means unlimited:
  // neither has a ratio, and there is nothing to breach.
  if (!(limit > 0) || !(used > 0) || !(periodDays > 0)) return null;

  const now = input.now ?? Date.now();
  const total = periodDays * DAY_MS;
  const periodStart = reset.getTime() - total;
  const elapsed = now - periodStart;
  // Before the period opened, or exactly at its boundary: no elapsed time to
  // divide by, and extrapolating from zero elapsed gives infinity.
  if (elapsed <= 0) return null;

  // Past the reset the period is over; the pace IS the usage, with no
  // extrapolation, rather than a figure scaled by a fraction above one.
  const scale = elapsed >= total ? 1 : total / elapsed;
  const projected = Math.round(used * scale);
  return {
    projected,
    ratio: projected / limit,
    willBreach: projected > limit,
    elapsedFraction: Math.min(1, elapsed / total),
  };
}

/**
 * The band at which a projection is worth showing a person.
 *
 * Shared so the card's forecast row and the profile's pressure signal agree on
 * what "approaching" means. Below it there is a projection but no reason to say
 * anything, which is a different state from having no projection at all.
 */
export const PROJECTION_NOTICE_RATIO = 0.7;

/** Whether a projection has crossed into the band worth surfacing. */
export function projectionWorthShowing(p: UsageProjection | null): boolean {
  return p !== null && p.ratio >= PROJECTION_NOTICE_RATIO;
}
