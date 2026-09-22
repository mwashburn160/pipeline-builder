// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared `@pipeline-builder/api-core` mock factory for ESM suites.
 *
 * WHY: every project kept its own `test/helpers/mock-api-core.ts` — twelve forks
 * of the same ~150-line file, ranging from 23 to 61 overridden keys against an
 * api-core barrel exporting ~357 symbols. Each fork re-declared the same logger
 * stub, the same `ErrorCode` proxy, the same error classes and the same
 * service-gate re-implementations, and each drifted independently.
 *
 * THE FIX: the shared parts live here, once. A project's helper keeps ONLY the
 * defaults that are genuinely project-specific (its tier fixtures, its compliance
 * client, its response helpers) and layers them on top:
 *
 *   const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
 *   export function apiCoreMock(overrides: Record<string, unknown> = {}) {
 *     return baseApiCoreMock(actualApiCore, { ...projectDefaults, ...overrides });
 *   }
 *
 * Both this module and the per-project helpers start from `requireActual`, so an
 * export ADDED to api-core is inherited automatically and can never again break a
 * suite with "does not provide an export named X".
 *
 * WHY IT LIVES IN api-core: the deep path
 * `@pipeline-builder/api-core/lib/testing/mock-api-core.js` is a different
 * specifier from the `@pipeline-builder/api-core` barrel, so a suite's module
 * mock does NOT intercept it — the factory can therefore read the real module
 * without recursing into its own mock. Same trick as `tier-mock.ts`.
 */

import { jest } from '@jest/globals';

/** Minimal Express-ish shapes the gate/response stubs below touch. */
type MockRes = { status: (n: number) => { json: (b: unknown) => unknown } };
type Next = () => void;

/** A bare `jest.fn()`, named so the emitted `.d.ts` stays portable (TS2883). */
type MockFn = ReturnType<typeof jest.fn>;

/** The winston double every suite asserts on: four spies, nothing else. */
export interface MockLogger {
  info: MockFn;
  warn: MockFn;
  error: MockFn;
  debug: MockFn;
}

/** The 4-method winston stub every suite repeats; a fresh set of spies per call. */
export const loggerMock = (): MockLogger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

/** Mirrors api-core: `ErrorCode.ANY_CODE` resolves to the string `'ANY_CODE'`. */
export const mockErrorCode = new Proxy({}, { get: (_t, key) => key }) as Record<string, string>;

/** No-op guard: the default mock covers route wiring, not the permission gate. */
export const passThroughMiddleware = (_req: unknown, _res: unknown, next: Next): void => next();

/** Mirrors api-core's `AppError` base (typed HTTP error: statusCode + code). */
export class MockAppError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message?: string) {
    super(message);
    this.name = 'AppError';
  }
}

/** Mirrors api-core's NotFoundError (404 / NOT_FOUND). */
export class MockNotFoundError extends MockAppError {
  constructor(message?: string) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

/** Mirrors api-core's ConflictError (409 / CONFLICT). */
export class MockConflictError extends MockAppError {
  constructor(message?: string, code = 'CONFLICT') {
    super(409, code, message);
    this.name = 'ConflictError';
  }
}

/** Mirrors api-core's ForbiddenError (403 / INSUFFICIENT_PERMISSIONS). */
export class MockForbiddenError extends MockAppError {
  constructor(message?: string) {
    super(403, 'INSUFFICIENT_PERMISSIONS', message);
    this.name = 'ForbiddenError';
  }
}

/** Mirrors api-core's ValidationError (400 / VALIDATION_ERROR). */
export class MockValidationError extends MockAppError {
  constructor(message?: string) {
    super(400, 'VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

/**
 * Capability-aware stand-in for api-core's `requirePermission` /
 * `requireAllPermissions` gate factories. Mirrors the real gate's decision (minus
 * the denial-audit side effect): superadmin passes, otherwise the caller must
 * hold the permission(s); a miss is a 403 with the real message shape.
 *
 * `onAnonymous` picks what happens when there is no `req.user` at all: `'pass'`
 * (suites with no auth layer mounted) or `'401'` (suites that drive the gate).
 * `shape` picks the denial envelope the project's suites assert on.
 */
export function mockPermissionGate(options: {
  mode?: 'some' | 'every';
  allowService?: boolean;
  onAnonymous?: 'pass' | '401';
  shape?: 'error' | 'message';
} = {}) {
  const { mode = 'some', allowService = false, onAnonymous = 'pass', shape = 'message' } = options;
  const joiner = mode === 'some' ? ' or ' : ' and ';
  const deny = (msg: string) => (shape === 'error' ? { error: msg } : { success: false, message: msg });
  return (...permissions: string[]) => {
    const gate = (req: { user?: { isSuperAdmin?: boolean; permissions?: string[]; sub?: string } }, res: MockRes, next: Next): unknown => {
      const user = req?.user;
      if (!user) return onAnonymous === 'pass' ? next() : res.status(401).json({ error: 'Authentication required' });
      if (allowService && typeof user.sub === 'string' && user.sub.startsWith('service:')) return next();
      if (user.isSuperAdmin === true) return next();
      const held = Array.isArray(user.permissions) ? user.permissions : [];
      const ok = mode === 'some' ? permissions.some((p) => held.includes(p)) : permissions.every((p) => held.includes(p));
      if (ok) return next();
      return res.status(403).json(deny(`Missing required permission: ${permissions.join(joiner)}`));
    };
    // Tags let a wiring suite locate the gate layer in a router stack and assert
    // which flavour was mounted.
    (gate as unknown as Record<string, unknown>).__permission = permissions.join(joiner);
    (gate as unknown as Record<string, unknown>).__allowService = allowService;
    return gate;
  };
}

/**
 * The defaults shared by every service / package mock: the logger stub, the
 * pagination constants, the inert scheduler / leader-lock / redis-audit wiring a
 * boot module links at load, and the error + cache shapes. A project layers its
 * own defaults on top by passing them in `overrides`.
 */
export function serviceApiCoreDefaults(): Record<string, unknown> {
  return {
    createLogger: loggerMock,
    MAX_PAGE_LIMIT: 1000,
    DEFAULT_PAGE_LIMIT: 100,
    closeLeaderLock: async () => undefined,
    loadAndRestore: async () => null,
    REPORT_INTERVALS: ['day', 'week', 'month'],
    scrubAwsIdentifiersFromString: (s: string) => s,
    scrubAwsIdentifiers: <T>(v: T): T => v,
    createScheduler: () => ({ start: () => undefined, stop: () => undefined }),
    createEnvRedisLock: () => null,
    requireStepUp: (_req: unknown, _res: unknown, next: Next) => next(),
    SYSTEM_ORG_ID: '000000000000000000000001',
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode: mockErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    NotFoundError: MockNotFoundError,
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
  };
}

/**
 * The audit / security wiring a service's boot module (`src/index.ts`,
 * `src/services/audit.ts`) links at load time. Inert by default: nothing asserts
 * on the registration, and pulling the real graph in would drag Redis + HTTP
 * clients into every route suite.
 */
export function serviceAuditDefaults(): Record<string, unknown> {
  return {
    createRemoteAuditClient: () => ({ record: jest.fn() }),
    createEnvRedisAuditSpool: () => null,
    createServiceAuditClient: () => ({ emit: jest.fn(), client: { record: jest.fn() } }),
    createRemoteAuditAccessor: () => ({ getAuditClient: () => ({ record: jest.fn() }), emit: jest.fn() }),
    setAuthzDenialAuditor: () => {},
    wireAuthzDenialAuditor: () => {},
    wireServiceSecurity: () => {},
    setTokenRevocationStore: () => {},
    createRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    createEnvRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
  };
}

/**
 * Build an api-core mock namespace: REAL api-core, then the shared service
 * defaults, then `overrides` (a project's own defaults merged with the suite's).
 *
 * `actualApiCore` is supplied by the CALLER (`jest.requireActual(...)` at the top
 * of the project's `test/helpers/mock-api-core.ts`) rather than resolved here.
 * That is deliberate: `requireActual` on an ESM barrel only succeeds at a moment
 * when nothing else is mid-`import()` of it, and the project helper — a static
 * import of the test file, evaluated before any `await import(SUT)` — is the one
 * point where that always holds. Resolving it from inside this module (which
 * lives in the api-core package itself) races that import in some suites.
 */
export function baseApiCoreMock(
  actualApiCore: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...actualApiCore, ...serviceApiCoreDefaults(), ...overrides };
}

/**
 * Build an api-core mock namespace with NO service defaults — REAL api-core plus
 * the logger stub and `ErrorCode` proxy only. Platform uses this: it deliberately
 * keeps api-core's real pagination/report constants and supplies its own
 * (large) identity/tier/permission default set.
 */
export function primitiveApiCoreMock(
  actualApiCore: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...actualApiCore, createLogger: loggerMock, ErrorCode: mockErrorCode, ...overrides };
}

/**
 * Mirror api-core's `requireInternalService({ callers })`: refuse any user token,
 * then refuse a service whose name is not in the route's caller list. Resolved
 * from the MERGED mock (rather than inherited from `requireActual`) so it uses
 * the suite's `isServicePrincipal` / `serviceNameOf` / `sendError`, which the real
 * one closes over and would write past.
 */
export function withInternalServiceGate(mock: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  if (overrides.requireInternalService !== undefined) return mock;
  mock.requireInternalService = ({ callers }: { callers: readonly string[] }) =>
    (req: unknown, res: unknown, next: Next) => {
      const isSvc = mock.isServicePrincipal as ((r: unknown) => boolean) | undefined;
      const nameOf = mock.serviceNameOf as ((c: unknown) => string | undefined) | undefined;
      const caller = nameOf?.((req as { user?: unknown }).user);
      if (isSvc?.(req) && caller && callers.includes(caller)) {
        next();
        return;
      }
      const sendError = mock.sendError as (r: unknown, s: number, m: string, c: string) => unknown;
      sendError(res, 403, 'Internal service calls only', 'INSUFFICIENT_PERMISSIONS');
    };
  return mock;
}

/**
 * Mirror api-core's `requireServicePrincipal`: reject a non-service caller with a
 * 403 INSUFFICIENT_PERMISSIONS (an authorization refusal, not a 400), resolving
 * `isServicePrincipal` / `sendError` from the merged mock.
 */
export function withServicePrincipalGate(mock: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  if (overrides.requireServicePrincipal !== undefined) return mock;
  mock.requireServicePrincipal = (req: unknown, res: unknown, next: Next) => {
    const isSvc = mock.isServicePrincipal as ((r: unknown) => boolean) | undefined;
    if (isSvc?.(req)) {
      next();
      return;
    }
    const sendError = mock.sendError as (r: unknown, s: number, m: string, c: string) => unknown;
    sendError(res, 403, 'Internal service calls only', 'INSUFFICIENT_PERMISSIONS');
  };
  return mock;
}

/**
 * `sendBadRequest` delegating to the (possibly-overridden) `sendError`, mirroring
 * the real implementation — so a suite spying on `sendError` also observes the
 * 400s routed through `sendBadRequest`.
 */
export function withDelegatingSendBadRequest(mock: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  if ('sendBadRequest' in overrides) return mock;
  mock.sendBadRequest = (res: unknown, message: string, code?: string) =>
    (mock.sendError as (r: unknown, s: number, m: string, c?: string) => unknown)(
      res, 400, message, code ?? mockErrorCode.VALIDATION_ERROR);
  return mock;
}
