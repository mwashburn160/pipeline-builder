// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lockstep guard: every feature a plan MARKETS as an included base perk must be
 * present in that tier's ENFORCED entitlement set (TIER_FEATURES) — otherwise a
 * paying customer is promised a feature that `requireFeature` will 403 on.
 *
 * The marketed base-feature perks are currently DERIVED from TIER_FEATURES (see
 * billing-config `defaultFeatures`), so this can't fail today; the test exists to
 * fail CI if a future change reverts to hand-copied perk strings and drifts.
 *
 * Bundle-purchasable features (advanced_reporting, team_usage_analytics, the
 * compliance libraries) are add-ons sold separately, so marketing may
 * legitimately mention them without them being a base entitlement — they are
 * excluded from the assertion. The exclusion set is DERIVED from the bundle
 * catalog rather than hand-listed, so withdrawing a bundle (as `sso` was) tightens
 * this guard automatically instead of leaving a permanent hole: `sso` is now a
 * pure tier feature and IS asserted against TIER_FEATURES like any other perk.
 *
 * Uses the REAL `@pipeline-builder/api-core` (no jest mock in this suite).
 */
import { describe, it, expect } from '@jest/globals';
import { FEATURE_METADATA, TIER_FEATURES, type FeatureFlag } from '@pipeline-builder/api-core';
import { loadBillingConfig } from '../src/config/billing-config.js';

// Features sold as separate add-on bundles — read off the live catalog so a
// withdrawn (or newly added) feature bundle can't leave this list stale.
const ADDON_FEATURES: ReadonlySet<FeatureFlag> = new Set<FeatureFlag>(
  loadBillingConfig().bundles.flatMap((b) => (b.features ?? []) as FeatureFlag[]),
);

// Reverse lookup: customer-facing marketed label -> canonical feature flag.
const LABEL_TO_FLAG = new Map<string, FeatureFlag>(
  (Object.keys(FEATURE_METADATA) as FeatureFlag[]).map((f) => [FEATURE_METADATA[f].label, f]),
);

describe('plan marketing / entitlement lockstep', () => {
  const { plans } = loadBillingConfig();

  it('sells no bundle granting `sso`, so it is held to the base-entitlement rule', () => {
    // Guards the derivation above: if SSO ever came back as an add-on, the
    // exclusion set would silently swallow it again and the lockstep assertion
    // below would stop covering the tier that markets it.
    expect(ADDON_FEATURES.has('sso')).toBe(false);
  });

  it.each(plans.map((p) => [p.id, p] as const))(
    'every base feature marketed by the %s plan is enforced in TIER_FEATURES',
    (_id, plan) => {
      const enforced = new Set<FeatureFlag>(TIER_FEATURES[plan.tier]);
      for (const perk of plan.features) {
        const flag = LABEL_TO_FLAG.get(perk);
        if (!flag) continue; // non-gated marketing line (limits, dashboards, RBAC, support level)
        if (ADDON_FEATURES.has(flag)) continue; // purchasable add-on, not a base entitlement
        expect(enforced.has(flag)).toBe(true);
      }
    },
  );
});
