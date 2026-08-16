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
// Shared tier fixture — deep path is NOT intercepted by the api-core module mock
// (see tier-mock.ts). Sources the tier NAME LIST from the real VALID_TIERS.
import { MOCK_TIER_NAMES, mockIsValidTier, mockQuotaTiers } from '@pipeline-builder/api-core/lib/testing/tier-mock.js';

/** The 4-method logger stub every suite repeats; a fresh set of spies per call. */
export const loggerMock = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

/** Mirrors api-core: `ErrorCode.ANY_CODE` resolves to the string `'ANY_CODE'`. */
const ErrorCode = new Proxy({}, { get: (_t, key) => key }) as Record<string, string>;

/**
 * Per-tier quota limits, shared by the `QUOTA_TIERS` export and `getTierLimits`
 * below so they can't drift. pipeline-core's `config/entitlements.ts` imports
 * `getTierLimits` at module load (it derives seat lines / effective entitlements
 * from a tier's limits), so the transitively-loaded graph needs it or ESM
 * linking against this mock throws "does not provide an export named
 * getTierLimits".
 */
const TIER_LIMITS: Record<string, Record<string, number>> = {
  developer: { seats: 1, plugins: 50, pipelines: 5, apiCalls: 25000, aiCalls: 50 },
  pro: { seats: 3, plugins: 500, pipelines: 50, apiCalls: 500000, aiCalls: 2500 },
  team: { seats: 10, plugins: 2000, pipelines: 200, apiCalls: -1, aiCalls: 10000 },
  enterprise: { seats: -1, plugins: 5000, pipelines: 500, apiCalls: -1, aiCalls: 25000 },
  unlimited: { seats: -1, plugins: -1, pipelines: -1, apiCalls: -1, aiCalls: -1 },
};

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
    writeSseHeaders: () => undefined,
    MAX_PAGE_LIMIT: 1000,
    DEFAULT_PAGE_LIMIT: 100,
    closeLeaderLock: async () => undefined,
    loadAndRestore: async () => null,
    REPORT_INTERVALS: ['day', 'week', 'month'],
    scrubAwsIdentifiersFromString: (s: string) => s,
    scrubAwsIdentifiers: <T>(v: T): T => v,
    createEnvRedisLock: () => null,
    requireStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
    // Optional-dep require shim → always "unavailable" so callers fall back to no-ops.
    safeCreateRequire: () => ((_id: string) => { throw new Error('require unavailable in tests'); }),
    // Scheduler factory stub — no-op start/stop (real behaviour tested in api-core).
    createScheduler: () => ({ start: () => undefined, stop: () => undefined }),
    // pipeline-core's barrel imports this (createServiceClient); link-time stub.
    InternalHttpClient: class {},
    SYSTEM_ORG_ID: '000000000000000000000001',
    // sse-connection-manager imports this constant for its ticket TTL — the
    // transitively-loaded graph (context-middleware attaches the SSEManager)
    // needs it or ESM linking against the mock throws "does not provide an
    // export named SSE_TICKET_TTL_MS".
    SSE_TICKET_TTL_MS: 30_000,
    // pipeline-core's billing-config imports QUOTA_TIERS at module load (derives
    // marketing copy from each tier's limits), so the transitively-loaded graph
    // needs an entry for EVERY tier. Built from the shared fixture over the real
    // tier list, with this mock's limit values as overrides; unspecified/new
    // tiers default to uncapped.
    QUOTA_TIERS: mockQuotaTiers(TIER_LIMITS),
    // Mirrors api-core: returns a tier's limits, defaulting unknown tiers to developer.
    getTierLimits: (tier: string) => TIER_LIMITS[tier] ?? TIER_LIMITS.developer,
    DEFAULT_TIER: 'developer',
    VALID_TIERS: [...MOCK_TIER_NAMES],
    STANDARD_TIERS: MOCK_TIER_NAMES.filter((t) => t !== 'unlimited'),
    // billing-config also derives marketed feature copy from the enforced entitlement
    // set + labels, so the transitively-loaded graph needs these too (ESM linking).
    TIER_FEATURES: {
      developer: [],
      pro: ['priority_support', 'ai_generation', 'bulk_operations'],
      team: ['priority_support', 'ai_generation', 'bulk_operations', 'audit_log', 'sso'],
      enterprise: ['priority_support', 'ai_generation', 'bulk_operations', 'audit_log', 'sso', 'custom_integrations'],
      unlimited: ['priority_support', 'ai_generation', 'bulk_operations', 'audit_log', 'sso', 'custom_integrations'],
    },
    FEATURE_METADATA: {
      priority_support: { label: 'Priority Support', description: '' },
      ai_generation: { label: 'AI Generation', description: '' },
      bulk_operations: { label: 'Bulk Operations', description: '' },
      audit_log: { label: 'Audit Log', description: '' },
      sso: { label: 'SSO', description: '' },
      custom_integrations: { label: 'Custom Integrations', description: '' },
    },
    isValidTier: mockIsValidTier,
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    // Functional sendError double mirroring api-core's envelope: writes the
    // standard error shape via res.status(...).json(...). Suites that assert on
    // the call override this with a jest.fn() (overrides win).
    sendError: (res: any, statusCode: number, message: string, code?: string, details?: unknown) => {
      if (res.headersSent) return;
      const body: Record<string, unknown> = { success: false, statusCode, message };
      if (code) body.code = code;
      if (details !== undefined) body.details = details;
      res.status(statusCode).json(body);
    },
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    // SSE payload redactor — passthrough by default; suites that assert on the
    // redaction (request-types) override with a spy.
    redactSensitive: (v: unknown) => v,
    // Shared env-Redis client factory → null (no Redis) so idempotency /
    // SSE-ticket stores fall back to their in-memory defaults in tests.
    createEnvRedisClient: () => null,
    // Sanitized DB-error extractor: tests don't surface pg metadata, so default to {}.
    extractDbError: () => ({}),
    NotFoundError,
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    ...overrides,
  };
}
