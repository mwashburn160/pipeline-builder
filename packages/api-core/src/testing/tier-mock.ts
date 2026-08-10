// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared tier fixture for the per-package `@pipeline-builder/api-core` test
 * mocks (each suite's `test/helpers/mock-api-core.ts`).
 *
 * WHY A SEPARATE MODULE: every service mocks `@pipeline-builder/api-core` via
 * `jest.unstable_mockModule('@pipeline-builder/api-core', …)`. That intercepts the
 * *package* specifier only — this file is imported through the DEEP built path
 * `@pipeline-builder/api-core/lib/testing/tier-mock.js`, a different specifier the
 * mock does NOT intercept, so a mock can pull real, complete tier data without
 * self-referencing its own mock. api-core has no `exports` map, so the subpath
 * resolves; both sides are ESM so there's no interop wrinkle.
 *
 * WHAT IT BUYS: the tier NAME LIST is sourced from the real `VALID_TIERS`, so
 * adding a tier in `quota-tiers.ts` flows into every mock automatically — no more
 * "add a tier → hand-edit N mocks, discover the misses one gate round at a time"
 * (which is exactly how the `unlimited` tier broke pipeline-core/api-server/platform).
 * `mockQuotaTiers()` builds a COMPLETE `QUOTA_TIERS` (an entry for every tier) from
 * caller-supplied per-tier limits, defaulting any unspecified tier to uncapped — so
 * a new tier can never leave a `QUOTA_TIERS[tier].limits` undefined at mock load.
 */

import { ALL_FEATURE_FLAGS, type FeatureFlag } from '../types/feature-flags.js';
import { VALID_TIERS, type QuotaTier, type QuotaTierLimits } from '../types/quota-tiers.js';

/** The real, complete tier-name list — the single source mocks derive from. */
export const MOCK_TIER_NAMES: readonly QuotaTier[] = VALID_TIERS;

/** Mirrors api-core's `isValidTier`, driven by the shared name list. */
export const mockIsValidTier = (t: string): boolean =>
  (MOCK_TIER_NAMES as readonly string[]).includes(t);

/** Every quota dimension uncapped — the default for tiers a caller doesn't specify. */
const uncappedLimits = (): QuotaTierLimits => ({
  seats: -1,
  plugins: -1,
  pipelines: -1,
  apiCalls: -1,
  aiCalls: -1,
  storageBytes: -1,
  dashboards: -1,
  alertRules: -1,
  alertDestinations: -1,
  idpConfigs: -1,
});

const titleCase = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

type TierPreset = { label: string; limits: QuotaTierLimits };

/**
 * Build a COMPLETE `QUOTA_TIERS` map (one entry per real tier) for a mock.
 * Pass the per-tier limit overrides a suite actually asserts on; every other
 * dimension (and every unspecified tier) falls back to uncapped, so the map is
 * always exhaustive over `VALID_TIERS` — the property that keeps a newly-added
 * tier from crashing mock load.
 */
export function mockQuotaTiers(
  limitsByTier: Partial<Record<QuotaTier, Partial<QuotaTierLimits>>> = {},
): Record<QuotaTier, TierPreset> {
  return Object.fromEntries(
    MOCK_TIER_NAMES.map((t) => [
      t,
      { label: titleCase(t), limits: { ...uncappedLimits(), ...(limitsByTier[t] ?? {}) } },
    ]),
  ) as Record<QuotaTier, TierPreset>;
}

/**
 * Build a COMPLETE `TIER_FEATURES` map. Defaults every tier to all feature flags
 * (the common mock stance); pass overrides for suites that assert a narrower set.
 */
export function mockTierFeatures(
  featuresByTier: Partial<Record<QuotaTier, readonly FeatureFlag[]>> = {},
): Record<QuotaTier, readonly FeatureFlag[]> {
  return Object.fromEntries(
    MOCK_TIER_NAMES.map((t) => [t, featuresByTier[t] ?? [...ALL_FEATURE_FLAGS]]),
  ) as Record<QuotaTier, readonly FeatureFlag[]>;
}
