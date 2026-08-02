// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared `@pipeline-builder/api-core` mock for ESM suites.
 *
 * Collapses the factory that every suite passed to
 * `jest.unstable_mockModule('@pipeline-builder/api-core', () => ({ ... }))`.
 * Provides the winston-logger stub plus the api-core runtime VALUES that the
 * transitively loaded pipeline-core / pipeline-data graph imports — under
 * transpile-only/`verbatimModuleSyntax` those stay real imports, so the mock
 * must expose them or ESM linking against it throws "does not provide an
 * export named X". Pass `overrides` for the exports a given suite exercises
 * (spies it asserts on, a bespoke error class, a stateful cache, etc.).
 */
import { jest } from '@jest/globals';

/** No-op guard: the default mock covers route wiring, not the permission gate.
 *  Suites that assert the gate override `requirePermission` with real semantics. */
const passThroughMiddleware = (_req: unknown, _res: unknown, next: () => void) => next();

/** The 4-method logger stub every suite repeats; a fresh set of spies per call. */
export const loggerMock = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

/** Mirrors api-core: `ErrorCode.ANY_CODE` resolves to the string `'ANY_CODE'`. */
const ErrorCode = new Proxy({}, { get: (_t, key) => key }) as Record<string, string>;

/** Mirrors api-core's NotFoundError (statusCode 404 / code NOT_FOUND). */
class NotFoundError extends Error {
  statusCode = 404;
  code = 'NOT_FOUND';
  constructor(message?: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createLogger: loggerMock,
    SYSTEM_ORG_ID: '000000000000000000000001',
    // billing-helpers.syncEntitlements reads the tier's seat limit to sync it to
    // platform (the seat leg of the two-target fan-out).
    getTierLimits: (_tier: string) => ({
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
    }),
    VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls', 'aiCalls', 'storageBytes', 'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs'],
    // Tier→feature map — billing-helpers.pruneTierIncludedFeatureAddons reads this
    // to decide which pure-feature add-ons a destination tier now bundles in.
    // Mirrors the real api-core TIER_FEATURES (developer < pro < team < enterprise).
    TIER_FEATURES: {
      developer: [],
      pro: ['priority_support', 'ai_generation', 'bulk_operations'],
      team: ['priority_support', 'ai_generation', 'bulk_operations', 'audit_log', 'sso'],
      enterprise: ['priority_support', 'ai_generation', 'bulk_operations', 'custom_integrations', 'audit_log', 'sso', 'advanced_reporting', 'team_usage_analytics'],
    },
    // `requirePermission(...perms)` / `requirePermissionOrService(...perms)` are
    // factories that RETURN middleware, so each stub is a function producing the
    // pass-through guard. Suites exercising the gate override these with real
    // 403-unless-permitted semantics.
    requirePermission: () => passThroughMiddleware,
    requirePermissionOrService: () => passThroughMiddleware,
    // Service-to-service auth header minted for the quota/platform entitlement sync.
    getServiceAuthHeader: (_opts?: unknown) => 'Bearer test-service-token',
    // Remote audit client factory — kept for any module still linking it directly.
    createRemoteAuditClient: () => ({ record: () => {} }),
    createEnvRedisAuditSpool: () => null,
    // Leader-lock redis factory (marketplace-metering scheduler) — no lock in suites.
    createEnvRedisLock: () => null,
    // Service audit factory — src/services/audit.ts now links against this. Returns
    // the ServiceAuditClient shape: `emit` + a spool-backed `client` (RemoteAuditClient).
    createServiceAuditClient: () => ({ emit: jest.fn(), client: { record: jest.fn() } }),
    createRemoteAuditAccessor: () => ({ getAuditClient: () => ({ record: jest.fn() }), emit: jest.fn() }),
    // #5 failed-authz auditor registration (src/index.ts) — no-op in suites.
    setAuthzDenialAuditor: () => {},
    wireAuthzDenialAuditor: () => {},
    // Token-revocation reader hooks (session-invalidation) — stubbed for parity
    // so suites that transitively load the boot module still link.
    setTokenRevocationStore: () => {},
    createEnvRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    // Query-param + error helpers the route modules import at load time. Faithful
    // enough for linking + the happy path; suites asserting on them override.
    parseQueryString: (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined),
    sendError: (res: { status: (n: number) => { json: (b: unknown) => unknown } }, status: number, message: string, code?: string) =>
      res.status(status).json({ success: false, statusCode: status, message, code }),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    NotFoundError,
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    ...overrides,
  };
}
