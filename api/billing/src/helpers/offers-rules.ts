// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1's usage predicates, as PURE FUNCTIONS of profile history
 * (docs/plans/sales-agent.md).
 *
 * "A rule is a function of a `UsageProfile` (that is why Phase 0 persists one),
 * so the test shape is a set of GOLDEN PROFILES — a handful of hand-built
 * accounts covering each co-occurrence pattern, each disqualifier, and the
 * crossover case — asserted against the offer each should produce, including
 * the ones that should produce none. In a repository with eighteen thousand
 * tests, a rule engine that decides discounts should not be the part with
 * none."
 *
 * Nothing here reads a database, mints anything or spends a budget. It answers
 * one question — does this account's history satisfy this predicate — and the
 * grant path (Phase 2) decides what to do about it.
 */

import type { PromotionUsageConditions } from '../models/promotion.js';

/** The slice of a profile these predicates read. Structural, so a test can hand-build one. */
export interface ProfileLike {
  period: string;
  dimensions: Record<string, { ratio: number | null; crossed: number | null }>;
  addonsHeld: string[];
  subscriptionAgeDays: number;
  complete: boolean;
}

/** The pressure band a dimension must reach to count as "under pressure". */
export const PRESSURE_RATIO = 0.8;

export type UsageVerdict =
  | { matches: true }
  | { matches: false; reason: UsageRejection };

export type UsageRejection =
  | 'no_profile'
  | 'incomplete_profile'
  | 'dimension_absent'
  | 'not_sustained'
  | 'too_few_dimensions'
  | 'addon_missing'
  | 'addon_already_held'
  | 'subscription_too_young';

/**
 * Does this account's history satisfy `usage`?
 *
 * `history` is newest-first — the order `UsageProfile`'s `(orgId, computedAt)`
 * index returns. Sustained pressure is counted from the newest row BACKWARDS
 * and stops at the first period that breaks the streak, so "three consecutive
 * periods above 90%" means the three most recent, not any three in the account's
 * life. An account that was saturated last spring and is idle now is not a
 * candidate, and counting any three would make it one.
 *
 * FAILS CLOSED on a missing or incomplete profile (D8), and the default is the
 * closed one: a `usage` block that omits `requireCompleteProfile` still refuses
 * an incomplete profile. The opposite default would make the safe behaviour
 * something an operator has to remember.
 */
export function evaluateUsage(
  usage: PromotionUsageConditions | undefined,
  history: readonly ProfileLike[],
): UsageVerdict {
  if (!usage) return { matches: true };

  const latest = history[0];
  if (!latest) return { matches: false, reason: 'no_profile' };
  if (usage.requireCompleteProfile !== false && !latest.complete) {
    return { matches: false, reason: 'incomplete_profile' };
  }

  if (usage.minSubscriptionAgeDays != null && latest.subscriptionAgeDays < usage.minSubscriptionAgeDays) {
    return { matches: false, reason: 'subscription_too_young' };
  }

  for (const id of usage.holdsAddons ?? []) {
    if (!latest.addonsHeld.includes(id)) return { matches: false, reason: 'addon_missing' };
  }
  // The "already bought it" guard: offering a pack to an account that holds it
  // is the single most obvious way to look like nobody is paying attention.
  for (const id of usage.lacksAddons ?? []) {
    if (latest.addonsHeld.includes(id)) return { matches: false, reason: 'addon_already_held' };
  }

  if (usage.minDimensionsUnderPressure != null) {
    if (dimensionsUnderPressure(latest) < usage.minDimensionsUnderPressure) {
      return { matches: false, reason: 'too_few_dimensions' };
    }
  }

  if (usage.dimension) {
    const need = usage.sustainedPeriods ?? 1;
    const ratio = usage.ratio ?? PRESSURE_RATIO;
    // An absent dimension is NOT a zero ratio. The profile omits a dimension it
    // could not read, so treating absence as "0%" would silently answer "not
    // under pressure" for the one dimension nobody measured.
    if (!(usage.dimension in latest.dimensions)) {
      return { matches: false, reason: 'dimension_absent' };
    }
    if (sustainedPeriods(history, usage.dimension, ratio) < need) {
      return { matches: false, reason: 'not_sustained' };
    }
  }

  return { matches: true };
}

/** Dimensions at or above the pressure band in one period. */
export function dimensionsUnderPressure(profile: ProfileLike): number {
  return Object.values(profile.dimensions)
    .filter((d) => d.ratio !== null && d.ratio >= PRESSURE_RATIO)
    .length;
}

/**
 * Consecutive periods, newest first, in which `dimension` was at or above
 * `ratio`.
 *
 * Stops at the first period that breaks the streak rather than counting
 * matches: a streak is what distinguishes an account that has outgrown its tier
 * from one with a busy fortnight, and a count would conflate them.
 *
 * A period where the dimension is ABSENT breaks the streak rather than being
 * skipped. Skipping it would let two saturated periods either side of an
 * unreadable one count as two consecutive, which is a claim the data does not
 * support.
 */
export function sustainedPeriods(
  history: readonly ProfileLike[],
  dimension: string,
  ratio: number,
): number {
  let streak = 0;
  for (const profile of history) {
    const d = profile.dimensions[dimension];
    if (!d || d.ratio === null || d.ratio < ratio) break;
    streak += 1;
  }
  return streak;
}
