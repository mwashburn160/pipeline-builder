// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Effective-entitlement math for the account/entitlement model.
 *
 * The canonical "effective limits = tier base + Σ(bundle grants)" computation
 * lives here — next to the plan/bundle config it operates on — so ANY
 * account-scoped consumer (billing, and future quota/platform readers) shares
 * one implementation instead of re-deriving the coalesce. Pure: the tier limits
 * come from api-core (`getTierLimits`) and the bundle catalog is passed in.
 */

import { getTierLimits, type QuotaTier, type QuotaTierLimits } from '@pipeline-builder/api-core';
import type { BundleConfig } from './billing-types.js';

/**
 * The support-level bundles, WORST to BEST. Response levels replace one another
 * rather than stacking — an account is on one support level — but `BundleConfig`
 * has `stackable` and `requires` and no notion of mutual exclusion, so without
 * this a drifted or mistakenly stored add-on set can hold two levels at once and
 * yield a muddled entitlement (both flags set, contacts summed across levels).
 *
 * Order IS the precedence: the best level held wins. Index is the rank.
 */
const SUPPORT_LEVEL_RANK: readonly string[] = ['support_standard', 'support_priority', 'support_premium'];

/**
 * The single support bundle that applies, or undefined when none is held.
 *
 * Note this is defence in depth, not the primary gate: the add-on purchase route
 * should reject acquiring a second level up front. This keeps the CANONICAL math
 * coherent for every other caller — the drift reconciler and the
 * subscription-lifecycle sync both compute entitlements from stored state they
 * did not validate.
 */
function winningSupportLevel(addons: ReadonlyArray<{ bundleId: string; quantity: number }>): string | undefined {
  let best: string | undefined;
  let bestRank = -1;
  for (const { bundleId, quantity } of addons) {
    if (quantity <= 0) continue;
    const rank = SUPPORT_LEVEL_RANK.indexOf(bundleId);
    if (rank > bestRank) { bestRank = rank; best = bundleId; }
  }
  return best;
}

/**
 * Compute an account's EFFECTIVE entitlements = tier base limits + Σ(bundle
 * grants × quantity), plus the union of bundle-granted feature flags. A field
 * already `-1` (unlimited) stays `-1`. Pure; the catalog is passed in.
 */
export function effectiveEntitlements(
  tier: QuotaTier,
  addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
  bundles: readonly BundleConfig[],
): { limits: Record<keyof QuotaTierLimits, number>; features: string[] } {
  const limits = { ...getTierLimits(tier) } as Record<keyof QuotaTierLimits, number>;
  const features = new Set<string>();
  const byId = new Map(bundles.map((b) => [b.id, b]));
  // Response levels are mutually exclusive: resolve the one that applies BEFORE
  // summing, so a lower level contributes neither its flag nor its contacts.
  // Dropping the loser's grants is deliberate — a double purchase is a billing
  // error to resolve, not a reason to inflate the contact allowance into a count
  // that corresponds to nothing purchasable.
  const supportLevel = winningSupportLevel(addons);
  for (const { bundleId, quantity } of addons) {
    const bundle = byId.get(bundleId);
    if (!bundle || quantity <= 0) continue;
    if (SUPPORT_LEVEL_RANK.includes(bundleId) && bundleId !== supportLevel) continue;
    // Enforce the non-stackable invariant AND the maxQuantity ceiling in the
    // CANONICAL math, not just at the purchase route: a `stackable:false` bundle
    // counts once, and a stackable pack is clamped to its `maxQuantity` — so a
    // non-route caller (drift reconciler, subscription-lifecycle) can't over-grant
    // a quota from a stored/drifted quantity (e.g. a retention pack past its cap).
    const effectiveQty = bundle.stackable ? Math.min(quantity, bundle.maxQuantity ?? quantity) : 1;
    for (const [rawField, delta] of Object.entries(bundle.grants)) {
      // `grants` is a Partial map, so a value can be undefined — skip those.
      if (delta === undefined) continue;
      const field = rawField as keyof QuotaTierLimits; // grants keys ARE quota fields
      if (limits[field] === -1) continue; // already unlimited
      limits[field] = (limits[field] ?? 0) + delta * effectiveQty;
    }
    for (const f of bundle.features ?? []) features.add(f);
  }
  return { limits, features: [...features] };
}
