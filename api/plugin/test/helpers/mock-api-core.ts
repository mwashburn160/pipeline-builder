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
import { z } from 'zod';

/** No-op guard: the mock covers route wiring, not the auth/permission gate. */
const passThroughMiddleware = (_req: unknown, _res: unknown, next: () => void) => next();

/** Real zod enum so route modules that build `z.object({ visibility: VisibilitySchema… })`
 *  at load time link against the mock (mirrors api-core's `VisibilitySchema`). */
const VisibilitySchema = z.enum(['private', 'org', 'public']);

/** The 4-method logger stub every suite repeats; a fresh set of spies per call. */
export const loggerMock = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

/** Mirrors api-core: `ErrorCode.ANY_CODE` resolves to the string `'ANY_CODE'`. */
const ErrorCode = new Proxy({}, { get: (_t, key) => key }) as Record<string, string>;

/** Mirrors api-core's AppError base (typed HTTP error: statusCode + code). */
class AppError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message?: string) {
    super(message);
    this.name = 'AppError';
  }
}

/** Mirrors api-core's NotFoundError (statusCode 404 / code NOT_FOUND). */
class NotFoundError extends AppError {
  constructor(message?: string) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

/** Mirrors api-core's ConflictError (statusCode 409 / code CONFLICT). */
class ConflictError extends AppError {
  constructor(message?: string) {
    super(409, 'CONFLICT', message);
    this.name = 'ConflictError';
  }
}

/** Mirrors api-core's ForbiddenError (statusCode 403 / code INSUFFICIENT_PERMISSIONS). */
class ForbiddenError extends AppError {
  constructor(message?: string) {
    super(403, 'INSUFFICIENT_PERMISSIONS', message);
    this.name = 'ForbiddenError';
  }
}

/** Mirrors api-core's ValidationError (statusCode 400 / code VALIDATION_ERROR). */
class ValidationError extends AppError {
  constructor(message?: string) {
    super(400, 'VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

/**
 * The REAL api-core exports, used as the base of every mock below. Suites stub
 * only what they exercise; everything else is the genuine export, so adding an
 * export to api-core can never again break a suite with "does not provide an
 * export named X". (`requireActual` bypasses the module mock.)
 */
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...actualApiCore,
    createLogger: loggerMock,
    VisibilitySchema,
    MAX_PAGE_LIMIT: 1000,
    DEFAULT_PAGE_LIMIT: 100,
    closeLeaderLock: async () => undefined,
    loadAndRestore: async () => null,
    loadAndPurge: async () => null,
    getParam: (params: Record<string, string>, key: string) => params?.[key],
    // Route-response + access helpers, so a test that mounts the REAL index.js
    // (full route graph) resolves them without re-stubbing each one. Suites that
    // assert on responses still override these (overrides spread last).
    /* eslint-disable @typescript-eslint/no-explicit-any */
    // Real signature: (req, res, resource, userId, perm) => boolean — true lets the
    // write proceed, false means it already sent the 403. Default: allowed.
    requireVisibilityWriteAccess: () => true,
    sendSuccess: (res: any, statusCode: number, data?: unknown) => res.status(statusCode).json({ success: true, statusCode, data }),
    sendBadRequest: (res: any, message: string) => res.status(400).json({ success: false, message }),
    sendError: (res: any, statusCode: number, message: string) => res.status(statusCode).json({ success: false, message }),
    sendEntityNotFound: (res: any, entity?: string) => res.status(404).json({ success: false, message: `${entity ?? 'Entity'} not found` }),
    /* eslint-enable @typescript-eslint/no-explicit-any */
    REPORT_INTERVALS: ['day', 'week', 'month'],
    scrubAwsIdentifiersFromString: (s: string) => s,
    scrubAwsIdentifiers: <T>(v: T): T => v,
    createScheduler: () => ({ start: () => undefined, stop: () => undefined }),
    createEnvRedisLock: () => null,
    requireStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
    SYSTEM_ORG_ID: '000000000000000000000001',

    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    // `requirePermission(...perms)` is a factory that RETURNS middleware, so
    // the stub is a function producing the pass-through guard.
    requirePermission: () => passThroughMiddleware,
    // `requireFeature(feature)` — same factory shape. Suites asserting the
    // feature gate itself override this with a feature-aware stub.
    requireFeature: () => passThroughMiddleware,
    // Route handlers + the build queue import the shared audit client via
    // services/audit.ts; the boot path also registers an authz-denial sink.
    // Provide inert stubs so ESM linking against the mock resolves both.
    createRemoteAuditClient: () => ({ record: () => {} }),
    createEnvRedisAuditSpool: () => null,
    // Compliance client — upload AND update routes gate on it (fail-closed).
    // Default non-blocking; a suite testing a compliance block overrides it.
    createComplianceClient: () => ({
      validatePlugin: async () => ({ blocked: false, violations: [] }),
    }),
    getServiceAuthHeader: () => 'Bearer service-token',
    // Service audit factory — src/services/audit.ts now links against this. Returns
    // the ServiceAuditClient shape: `emit` + a spool-backed `client` (RemoteAuditClient).
    createServiceAuditClient: () => ({ emit: jest.fn(), client: { record: jest.fn() } }),
    createRemoteAuditAccessor: () => ({ getAuditClient: () => ({ record: jest.fn() }), emit: jest.fn() }),
    setAuthzDenialAuditor: () => {},
    wireAuthzDenialAuditor: () => {},
    wireServiceSecurity: () => {},
    // boot-time token-revocation reader registration (session-invalidation
    // option b) — stubbed so suites that transitively load the boot module link.
    setTokenRevocationStore: () => {},
    createRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    AppError,
    NotFoundError,
    ValidationError,
    ForbiddenError,
    ConflictError,
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    // Caller-authority probes the create/upload overwrite gate snapshots.
    // Default: an ordinary member (no admin, no publish); suites override.
    isSystemAdmin: () => false,
    userHasPermission: () => false,
    // Mirrors api-core: 503 (+Retry-After) when the quota service couldn't
    // confirm the reservation, 429 when the org is actually over its limit.
    sendQuotaReserveDenied: (res: any, _type: string, reservation: { unavailable?: boolean; quota?: unknown }) =>
      reservation.unavailable
        ? res.status(503).json({ success: false, statusCode: 503, code: 'SERVICE_UNAVAILABLE' })
        : res.status(429).json({ success: false, statusCode: 429, quota: reservation.quota }),
    ...overrides,
  };
}
