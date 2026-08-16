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
// (see tier-mock.ts). Sources the tier NAME LIST from the real VALID_TIERS so a
// new tier flows into this mock automatically.
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
    SYSTEM_ORG_ID: '000000000000000000000001',
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
    TIER_FEATURES: {
      developer: [],
      pro: ['priority_support', 'ai_generation', 'bulk_operations'],
      team: ['priority_support', 'ai_generation', 'bulk_operations', 'audit_log'],
      enterprise: ['priority_support', 'ai_generation', 'bulk_operations', 'custom_integrations', 'audit_log', 'sso'],
      unlimited: ['priority_support', 'ai_generation', 'bulk_operations', 'custom_integrations', 'audit_log', 'sso'],
    },
    FEATURE_METADATA: {
      priority_support: { label: 'Priority Support', description: '' },
      ai_generation: { label: 'AI Generation', description: '' },
      bulk_operations: { label: 'Bulk Operations', description: '' },
      custom_integrations: { label: 'Custom Integrations', description: '' },
      audit_log: { label: 'Audit Log', description: '' },
      sso: { label: 'SSO / IdP', description: '' },
    },
    // billing-config.ts derives its `plans` array from VALID_TIERS (in order) so
    // the plan set stays compile-bound to QuotaTier; the mock must expose it.
    VALID_TIERS: [...MOCK_TIER_NAMES],
    STANDARD_TIERS: MOCK_TIER_NAMES.filter((t) => t !== 'unlimited'),
    // billing-config.ts validates BILLING_BUNDLE_<ID>_TIERS entries with this.
    isValidTier: mockIsValidTier,
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    NotFoundError,
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    ...overrides,
  };
}
