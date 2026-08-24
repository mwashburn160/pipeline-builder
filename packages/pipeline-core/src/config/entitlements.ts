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
import type { BundleConfig } from './config-types.js';

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
  for (const { bundleId, quantity } of addons) {
    const bundle = byId.get(bundleId);
    if (!bundle || quantity <= 0) continue;
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
