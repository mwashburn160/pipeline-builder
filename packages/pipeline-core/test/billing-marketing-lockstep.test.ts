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
 * Bundle-purchasable features (`sso`, `audit_log`) are add-ons sold separately,
 * so marketing may legitimately mention them without them being a base
 * entitlement — they are excluded from the assertion.
 *
 * Uses the REAL `@pipeline-builder/api-core` (no jest mock in this suite).
 */
import { FEATURE_METADATA, TIER_FEATURES, type FeatureFlag } from '@pipeline-builder/api-core';
import { loadBillingConfig } from '../src/config/billing-config.js';

// Features sold as separate add-on bundles (see billing-config `loadBundles()`).
const ADDON_FEATURES: ReadonlySet<FeatureFlag> = new Set<FeatureFlag>(['sso', 'audit_log']);

// Reverse lookup: customer-facing marketed label -> canonical feature flag.
const LABEL_TO_FLAG = new Map<string, FeatureFlag>(
  (Object.keys(FEATURE_METADATA) as FeatureFlag[]).map((f) => [FEATURE_METADATA[f].label, f]),
);

describe('plan marketing / entitlement lockstep', () => {
  const { plans } = loadBillingConfig();

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
