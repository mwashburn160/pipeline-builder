// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Billing's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants, audit/boot wiring) live in
 * `@pipeline-builder/api-core/testing`. Only
 * billing-specific defaults belong here.
 *
 * ── WHY BILLING IS EXEMPT FROM THE spread-the-real-module RULE ──────────────
 * Everywhere else in the repo a module mock must start from the real module
 * (`drizzleMock`, `apiCoreMock`, platform's `controllerHelperMock`) so it cannot
 * go stale — and `no-restricted-syntax` in `.projenrc.ts` enforces that. Billing's
 * suites keep INLINE literal mocks for `../src/helpers/billing-helpers.js`,
 * `@pipeline-builder/api-server` and `@pipeline-builder/pipeline-data`, and the
 * lint rule exempts this project for those specifiers. That exemption is a known
 * debt, not a style preference — it was tried and reverted, and here is exactly
 * why, so nobody burns the same day rediscovering it:
 *
 *   `src/helpers/billing-helpers.ts` does `import { incCounter } from
 *   '@pipeline-builder/api-server'` at line 6, and its transitive graph
 *   VALIDATES CONFIG AT IMPORT ("MONGODB_URI environment variable is required
 *   when BILLING_ENABLED=true"). So `jest.requireActual` on it only succeeds
 *   inside a window that (a) opens after the suite registers its `../src/config.js`
 *   mock and sets env, and (b) closes before the suite's `await import(SUT)` puts
 *   billing-helpers in flight — resolving it inside the mock factory throws
 *   "Cannot require() ES Module … currently being loaded by a concurrent import()".
 *   Several suites have NO config mock at all, and `subscription-lifecycle.test.ts`
 *   registers its `@pipeline-builder/api-server` mock 40 lines AFTER where the
 *   `requireActual` would have to go. There is no single ordering that satisfies
 *   all 14 suites: 10 of 14 failed, 9 of them failing to load outright.
 *
 * The real fix is to make `billing-helpers.ts` importable without a validated
 * config (move the `incCounter` import behind the call site, and the config
 * assertion out of module scope). That is production source, so it is deliberately
 * NOT done here. Until then these inline mocks can silently go stale — that is the
 * risk being accepted, and it has already bitten once (`MANAGEABLE_SUBSCRIPTION_STATUSES`
 * is hand-copied into 10 suites).
 */
import { jest } from '@jest/globals';
import { TIER_FEATURES } from '@pipeline-builder/api-core/lib/types/feature-flags.js';
import {
  baseApiCoreMock,
  loggerMock,
  passThroughMiddleware,
  serviceAuditDefaults,
  withDelegatingSendBadRequest,
} from '@pipeline-builder/api-core/testing';
// Real TIER_FEATURES (side-effect-free deep import) so the mock can't drift from
// api-core — billing derives entitlement copy from it.

export { loggerMock };

/**
 * The REAL api-core exports, resolved HERE (not inside the shared factory):
 * `requireActual` on an ESM barrel only succeeds while nothing else is
 * mid-`import()` of it, and this module — a static import of every suite that
 * uses it, evaluated before the suite's `await import(SUT)` — is the one point
 * where that reliably holds.
 */
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;

/** Billing-specific defaults layered over the shared base. */
const billingDefaults = (): Record<string, unknown> => ({
  ...serviceAuditDefaults(),
  // Metrics no-op — the promotion engine emits `billing_promotion_*` counters.
  emitCounter: () => undefined,
  // billing-helpers.syncEntitlements reads the tier's seat limit to sync it to
  // platform (the seat leg of the two-target fan-out).
  getTierLimits: (tier: string) => ({
    seats: 10,
    plugins: 50,
    pipelines: 5,
    apiCalls: 25000,
    aiCalls: 50,
    storageBytes: 2147483648,
    dashboards: 20,
    alertRules: 50,
    alertDestinations: 10,
    idpConfigs: 1,
    listings: 3,
    // retention baselines — standard tiers 30/180; `unlimited` -1
    // (the retention leg pushes these effective values to reporting).
    eventRetentionDays: tier === 'unlimited' ? -1 : 30,
    doraRetentionDays: tier === 'unlimited' ? -1 : 180,
  }),
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls', 'aiCalls', 'storageBytes', 'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs', 'listings'],
  // Tier→feature map — billing-helpers.pruneTierIncludedFeatureAddons reads this
  // to decide which pure-feature add-ons a destination tier now bundles in.
  TIER_FEATURES,
  // `requirePermission(...perms)` / `requirePermissionOrService(...perms)` are
  // factories that RETURN middleware. Suites exercising the gate override these
  // with real 403-unless-permitted semantics.
  requirePermission: () => passThroughMiddleware,
  requirePermissionOrService: () => passThroughMiddleware,
  // Service-to-service auth header minted for the quota/platform entitlement sync.
  getServiceAuthHeader: (_opts?: unknown) => 'Bearer test-service-token',
  // Query-param + error helpers the route modules import at load time.
  parseQueryString: (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined),
  sendError: (res: { status: (n: number) => { json: (b: unknown) => unknown } }, status: number, message: string, code?: string) =>
    res.status(status).json({ success: false, statusCode: status, message, code }),
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...billingDefaults(), ...overrides };
  return withDelegatingSendBadRequest(baseApiCoreMock(actualApiCore, merged), overrides);
}
