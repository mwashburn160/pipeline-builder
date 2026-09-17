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

/**
 * Pass-through middleware stub. Route suites exercise handler logic directly,
 * not the auth gate, so `requirePermission` (and similar guards) default to
 * calling `next()`. A suite that wants to assert the gate can override it.
 */
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

/** Mirrors api-core's ConflictError (statusCode 409 / code CONFLICT). */
class ConflictError extends Error {
  statusCode = 409;
  code = 'CONFLICT';
  constructor(message?: string) {
    super(message);
    this.name = 'ConflictError';
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
  const mock: Record<string, unknown> = {
    ...actualApiCore,
    createLogger: loggerMock,
    MAX_PAGE_LIMIT: 1000,
    DEFAULT_PAGE_LIMIT: 100,
    closeLeaderLock: async () => undefined,
    loadAndRestore: async () => null,
    REPORT_INTERVALS: ['day', 'week', 'month'],
    scrubAwsIdentifiersFromString: (s: string) => s,
    scrubAwsIdentifiers: <T>(v: T): T => v,
    createScheduler: () => ({ start: () => undefined, stop: () => undefined }),
    requireStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
    SYSTEM_ORG_ID: '000000000000000000000001',
    isSystemOrgId: (orgId?: string) => orgId === '000000000000000000000001',

    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    // Module-load tunables (scan batch sizes, regex cap, …). Reads the env like
    // the real helper so a suite can set e.g. COMPLIANCE_SCAN_ENTITY_PAGE_SIZE.
    envInt: (name: string, def: number) => {
      const n = Number.parseInt(process.env[name] ?? '', 10);
      return Number.isFinite(n) ? n : def;
    },
    // Default no-op so route modules importing `sendError` link under ESM. A
    // suite asserting on responses can override with its own res-writing spy.
    sendError: jest.fn(),
    // `requirePermission(...perms)` is a factory that RETURNS middleware, so
    // the stub is a function producing the pass-through guard.
    requirePermission: () => passThroughMiddleware,
    requireFeature: () => passThroughMiddleware,
    // Service audit accessor — src/services/audit.ts links against this. Returns
    // the lazy accessor shape: `getAuditClient` (RemoteAuditClient) + `emit`.
    // Suites asserting `authz.denied` wire api-core's real sink instead.
    createRemoteAuditAccessor: () => ({ getAuditClient: () => ({ record: jest.fn() }), emit: jest.fn() }),
    wireServiceSecurity: () => {},
    // boot-time token-revocation reader registration (session-invalidation
    // option b) — stubbed so suites that transitively load the boot module link.
    setTokenRevocationStore: () => {},
    createRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    // Env-configured Redis helpers used by the boot module + schedulers after the
    // dead BullMQ compliance queue was removed. Default to no-Redis (fail-open):
    // the revocation reader returns null, the leader lock is absent (run-on-every-pod).
    createEnvRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    createEnvRedisLock: () => null,
    NotFoundError,
    ConflictError,
    // Link-only defaults for modules that import these at load (webhook SSRF
    // guard, compliance-attribute projection). Suites exercising them import the
    // real implementations instead.
    isPrivateAddress: () => false,
    toComplianceAttributes: <T>(v: T): T => v,
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    ...overrides,
  };

  // Mirror api-core's `requireServicePrincipal`: reject non-service callers with
  // a 403 INSUFFICIENT_PERMISSIONS (an authorization refusal, not a 400),
  // resolving `isServicePrincipal` and `sendError` from the merged mock so a
  // suite's overrides still win. A suite may supply its own gate instead.
  if (overrides.requireServicePrincipal === undefined) {
    mock.requireServicePrincipal = (req: unknown, res: unknown, next: () => void) => {
      const isSvc = mock.isServicePrincipal as ((r: unknown) => boolean) | undefined;
      if (isSvc?.(req)) {
        next();
        return;
      }
      const sendError = mock.sendError as (res: unknown, status: number, msg: string, code: string) => unknown;
      sendError(res, 403, 'Internal service calls only', 'INSUFFICIENT_PERMISSIONS');
    };
  }

  return mock;
}
