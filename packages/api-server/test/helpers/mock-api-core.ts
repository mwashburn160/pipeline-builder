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
    // Optional-dep require shim → always "unavailable" so callers fall back to no-ops.
    safeCreateRequire: () => ((_id: string) => { throw new Error('require unavailable in tests'); }),
    // Scheduler factory stub — no-op start/stop (real behaviour tested in api-core).
    createScheduler: () => ({ start: () => undefined, stop: () => undefined }),
    // pipeline-core's barrel imports this (createServiceClient); link-time stub.
    InternalHttpClient: class {},
    SYSTEM_ORG_ID: '000000000000000000000001',
    // pipeline-core's billing-config imports QUOTA_TIERS at module load (derives
    // marketing copy from each tier's limits), so the transitively-loaded graph
    // needs these tier exports or ESM linking against the mock throws.
    QUOTA_TIERS: {
      developer: { label: 'Developer', limits: { seats: 1, plugins: 50, pipelines: 5, apiCalls: 25000, aiCalls: 50 } },
      pro: { label: 'Pro', limits: { seats: 3, plugins: 500, pipelines: 50, apiCalls: 500000, aiCalls: 2500 } },
      team: { label: 'Team', limits: { seats: 10, plugins: 2000, pipelines: 200, apiCalls: -1, aiCalls: 10000 } },
      enterprise: { label: 'Enterprise', limits: { seats: -1, plugins: 5000, pipelines: 500, apiCalls: -1, aiCalls: 25000 } },
    },
    DEFAULT_TIER: 'developer',
    VALID_TIERS: ['developer', 'pro', 'team', 'enterprise'],
    isValidTier: (t: string) => ['developer', 'pro', 'team', 'enterprise'].includes(t),
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
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
