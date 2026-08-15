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

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const mock: Record<string, unknown> = {
    createLogger: loggerMock,
    REPORT_INTERVALS: ['day', 'week', 'month'],
    scrubAwsIdentifiersFromString: (s: string) => s,
    scrubAwsIdentifiers: <T>(v: T): T => v,
    createScheduler: () => ({ start: () => undefined, stop: () => undefined }),
    requireStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
    SYSTEM_ORG_ID: '000000000000000000000001',
    isSystemOrgId: (orgId?: string) => orgId === '000000000000000000000001',
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    // Default no-op so route modules importing `sendError` link under ESM. A
    // suite asserting on responses can override with its own res-writing spy.
    sendError: jest.fn(),
    // `requirePermission(...perms)` is a factory that RETURNS middleware, so
    // the stub is a function producing the pass-through guard.
    requirePermission: () => passThroughMiddleware,
    // Inline permission check (e.g. the deactivate gate in subscriptions.ts).
    // Defaults to "no permission" so route suites see plain-member behavior; a
    // suite exercising the gate overrides this with its own permission logic.
    userHasPermission: () => false,
    // Audit wiring: `services/audit.ts` builds a client over
    // `createRemoteAuditClient()`; boot registers an `authz.denied` auditor via
    // `setAuthzDenialAuditor`. Stub both so suites loading `audit.js` link.
    createRemoteAuditClient: () => ({ record: jest.fn() }),
    createEnvRedisAuditSpool: () => null,
    // Service audit factory — src/services/audit.ts now links against this. Returns
    // the ServiceAuditClient shape: `emit` + a spool-backed `client` (RemoteAuditClient).
    createServiceAuditClient: () => ({ emit: jest.fn(), client: { record: jest.fn() } }),
    setAuthzDenialAuditor: () => {},
    wireAuthzDenialAuditor: () => {},
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
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    ...overrides,
  };

  // `requireServicePrincipal` was promoted from identical local copies in the
  // entity-events / subscriptions routes into api-core. Mirror the old local
  // guard here: reject non-service callers by resolving `isServicePrincipal` and
  // `sendBadRequest` from the merged mock so a suite's overrides still win. A
  // suite may supply its own `requireServicePrincipal` to take precedence.
  if (mock.requireServicePrincipal === undefined) {
    mock.requireServicePrincipal = (req: unknown, res: unknown, next: () => void) => {
      const isSvc = mock.isServicePrincipal as ((r: unknown) => boolean) | undefined;
      if (isSvc?.(req)) {
        next();
        return;
      }
      const badRequest = mock.sendBadRequest as ((res: unknown, msg: string, code: string) => unknown) | undefined;
      badRequest?.(res, 'Internal service calls only', 'INSUFFICIENT_PERMISSIONS');
    };
  }

  return mock;
}
