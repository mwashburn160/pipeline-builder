// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pipeline-core's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants) live in
 * `@pipeline-builder/api-core/lib/testing/mock-api-core.js`. Only
 * pipeline-core-specific defaults belong here.
 */
import { jest } from '@jest/globals';
import { baseApiCoreMock, loggerMock } from '@pipeline-builder/api-core/lib/testing/mock-api-core.js';
// Shared tier fixture — deep path is NOT intercepted by the api-core module mock
// (see tier-mock.ts). Sources the tier NAME LIST from the real VALID_TIERS so a
// new tier flows into this mock automatically.
import { MOCK_TIER_NAMES, mockIsValidTier, mockQuotaTiers } from '@pipeline-builder/api-core/lib/testing/tier-mock.js';
// Real TIER_FEATURES + FEATURE_METADATA (matched pair; side-effect-free deep
// import) so these can't drift from api-core — a stale hand-copy diverges as
// features are added, and a partial FEATURE_METADATA throws on the flags it omits.
import { TIER_FEATURES, FEATURE_METADATA } from '@pipeline-builder/api-core/lib/types/feature-flags.js';

export { loggerMock };

/**
 * The REAL api-core exports, resolved HERE (not inside the shared factory):
 * `requireActual` on an ESM barrel only succeeds while nothing else is
 * mid-`import()` of it, and this module — a static import of every suite that
 * uses it, evaluated before the suite's `await import(SUT)` — is the one point
 * where that reliably holds.
 */
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;

/** pipeline-core-specific defaults layered over the shared base. */
const pipelineCoreDefaults = (): Record<string, unknown> => ({
  // Optional-dep require shim → always "unavailable" so callers fall back to no-ops.
  safeCreateRequire: () => ((_id: string) => { throw new Error('require unavailable in tests'); }),
  // Quota tier presets — billing-config.ts reads these at import time
  // (defaultFeatures derives marketing copy from each tier's limits), so the
  // mock must expose EVERY tier with a numeric `limits` shape. Built from the
  // shared fixture: the values below (asserted by billing-config.test, e.g.
  // "Up to 25 plugins") are preserved as overrides; any tier not listed —
  // incl. `unlimited` and any future addition — defaults to uncapped.
  QUOTA_TIERS: mockQuotaTiers({
    developer: { seats: 1, plugins: 25, pipelines: 5, apiCalls: 25000, aiCalls: 50 },
    pro: { seats: 1, plugins: 50, pipelines: 10, apiCalls: 500000, aiCalls: 2500 },
    team: { seats: 10, plugins: 100, pipelines: 200, apiCalls: -1, aiCalls: 10000 },
    enterprise: { seats: 25, plugins: 250, pipelines: 200, apiCalls: -1, aiCalls: 25000 },
  }),
  // billing-config.ts also derives marketed "included feature" perks from the
  // enforced entitlement set at import time, so the mock must expose both the
  // tier→feature map and the label metadata (must mirror the real api-core).
  TIER_FEATURES,
  FEATURE_METADATA,
  // billing-config.ts derives its `plans` array from VALID_TIERS (in order) so
  // the plan set stays compile-bound to QuotaTier; the mock must expose it.
  VALID_TIERS: [...MOCK_TIER_NAMES],
  STANDARD_TIERS: MOCK_TIER_NAMES.filter((t) => t !== 'unlimited'),
  // billing-config.ts validates BILLING_BUNDLE_<ID>_TIERS entries with this.
  isValidTier: mockIsValidTier,
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseApiCoreMock(actualApiCore, { ...pipelineCoreDefaults(), ...overrides });
}
