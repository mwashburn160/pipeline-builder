// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * api-server's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants) live in
 * `@pipeline-builder/api-core/lib/testing/mock-api-core.js`. Only
 * api-server-specific defaults belong here.
 */
import { jest } from '@jest/globals';
import { baseApiCoreMock, loggerMock } from '@pipeline-builder/api-core/lib/testing/mock-api-core.js';
// Shared tier fixture — deep path is NOT intercepted by the api-core module mock
// (see tier-mock.ts). Sources the tier NAME LIST from the real VALID_TIERS.
import { MOCK_TIER_NAMES, mockIsValidTier, mockQuotaTiers } from '@pipeline-builder/api-core/lib/testing/tier-mock.js';
// The REAL TIER_FEATURES (side-effect-free deep import, same pattern as tier-mock)
// so this can't drift from api-core — a hand-copy silently diverges as features
// are added.
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

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Per-tier quota limits, shared by the `QUOTA_TIERS` export and `getTierLimits`
 * below so they can't drift. pipeline-core's `config/entitlements.ts` imports
 * `getTierLimits` at module load (it derives seat lines / effective entitlements
 * from a tier's limits), so the transitively-loaded graph needs it.
 */
const TIER_LIMITS: Record<string, Record<string, number>> = {
  developer: { seats: 1, plugins: 50, pipelines: 5, apiCalls: 25000, aiCalls: 50 },
  pro: { seats: 3, plugins: 500, pipelines: 50, apiCalls: 500000, aiCalls: 2500 },
  team: { seats: 10, plugins: 2000, pipelines: 200, apiCalls: -1, aiCalls: 10000 },
  enterprise: { seats: -1, plugins: 5000, pipelines: 500, apiCalls: -1, aiCalls: 25000 },
  unlimited: { seats: -1, plugins: -1, pipelines: -1, apiCalls: -1, aiCalls: -1 },
};

/** api-server-specific defaults layered over the shared base. */
const apiServerDefaults = (): Record<string, unknown> => ({
  // Fail-open paths emit `quota_fail_open_total` so an outage is alertable;
  // a no-op here keeps the counter out of the assertions that don't care.
  emitCounter: jest.fn(),
  writeSseHeaders: () => undefined,
  // Optional-dep require shim → always "unavailable" so callers fall back to no-ops.
  safeCreateRequire: () => ((_id: string) => { throw new Error('require unavailable in tests'); }),
  // pipeline-core's barrel imports this (createServiceClient); link-time stub.
  InternalHttpClient: class {},
  // sse-connection-manager imports this constant for its ticket TTL.
  SSE_TICKET_TTL_MS: 30_000,
  // sse-connection-manager builds its default log ticket store with this, and
  // app-factory the env-backed one; link-time stubs for the transitive graph.
  createMemorySseTicketStore: () => ({}),
  createEnvSseTicketStore: () => ({}),
  // pipeline-core's billing-config imports QUOTA_TIERS at module load (derives
  // marketing copy from each tier's limits), so the transitively-loaded graph
  // needs an entry for EVERY tier.
  QUOTA_TIERS: mockQuotaTiers(TIER_LIMITS),
  // Mirrors api-core: returns a tier's limits, defaulting unknown tiers to developer.
  getTierLimits: (tier: string) => TIER_LIMITS[tier] ?? TIER_LIMITS.developer,
  DEFAULT_TIER: 'developer',
  VALID_TIERS: [...MOCK_TIER_NAMES],
  STANDARD_TIERS: MOCK_TIER_NAMES.filter((t) => t !== 'unlimited'),
  // billing-config also derives marketed feature copy from the enforced entitlement
  // set + labels, so the transitively-loaded graph needs these too (ESM linking).
  TIER_FEATURES,
  FEATURE_METADATA,
  isValidTier: mockIsValidTier,
  // Functional sendError double mirroring api-core's envelope. Suites that assert
  // on the call override this with a jest.fn() (overrides win).
  sendError: (res: any, statusCode: number, message: string, code?: string, details?: unknown) => {
    if (res.headersSent) return;
    const body: Record<string, unknown> = { success: false, statusCode, message };
    if (code) body.code = code;
    if (details !== undefined) body.details = details;
    res.status(statusCode).json(body);
  },
  // Functional sendQuotaExceeded double mirroring api-core's envelope: sets the
  // quota headers and delegates to a 429 error body.
  sendQuotaExceeded: (res: any, quotaType: string, quota: { limit: number; used: number; remaining: number }, _resetAt?: string, message?: string) => {
    if (res.headersSent) return;
    res.status(429).json({
      success: false,
      statusCode: 429,
      message: message ?? `${quotaType} quota exceeded (${quota.used}/${quota.limit}). Please try again later.`,
      code: 'QUOTA_EXCEEDED',
      details: { quota },
    });
  },
  // SSE payload redactor — passthrough by default; suites that assert on the
  // redaction (request-types) override with a spy.
  redactSensitive: (v: unknown) => v,
  // Shared env-Redis client factory → null (no Redis) so idempotency /
  // SSE-ticket stores fall back to their in-memory defaults in tests.
  createEnvRedisClient: () => null,
  // Sanitized DB-error extractor: tests don't surface pg metadata, so default to {}.
  extractDbError: () => ({}),
});

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseApiCoreMock(actualApiCore, { ...apiServerDefaults(), ...overrides });
}
