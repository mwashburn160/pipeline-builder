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

/** Minimal shapes the permission-gate mocks touch on the request/response. */
type MockUser = { isSuperAdmin?: boolean; permissions?: string[] };
type GateReq = { user?: MockUser };
type GateRes = { status: (n: number) => { json: (b: unknown) => void } };

/**
 * Capability-aware stand-in for api-core's `requirePermission` /
 * `requireAllPermissions`. Mirrors the real gate's decision (minus the
 * denial-audit side effect):
 *   - no `req.user` at all → PASS (suites without an auth layer keep working,
 *     exactly as the old `requireSystemAdmin` passthrough did);
 *   - `req.user.isSuperAdmin` → PASS (implicit-all, as in production);
 *   - otherwise gate on `req.user.permissions` (`some` for any-of,
 *     `every` for all-of), 403 with the same message shape on a miss.
 * `joiner` is `' or '` for any-of and `' and '` for all-of, matching the real
 * error strings the routes' callers may assert on.
 */
function permissionGate(mode: 'some' | 'every', joiner: string) {
  return (...perms: string[]) => (req: GateReq, res: GateRes, next: () => void): void => {
    const user = req.user;
    if (!user) return next();
    if (user.isSuperAdmin) return next();
    const held = user.permissions ?? [];
    const ok = mode === 'some' ? perms.some((p) => held.includes(p)) : perms.every((p) => held.includes(p));
    if (ok) return next();
    res.status(403).json({ success: false, message: `Missing required permission: ${perms.join(joiner)}` });
  };
}

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createLogger: loggerMock,
    SYSTEM_ORG_ID: '000000000000000000000001',
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    // Permission gates the /api/images + /api/admin routes attach per-route.
    // Capability-aware: superadmin ⇒ pass; else check req.user.permissions.
    requirePermission: permissionGate('some', ' or '),
    requireAllPermissions: permissionGate('every', ' and '),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    // Remote audit client factory — the registry's audit wiring
    // (src/services/audit.ts) links against this. Default returns a no-op
    // recorder; suites asserting on emitted audit events mock the audit module
    // (src/services/audit.js) directly instead.
    createRemoteAuditClient: () => ({ record: jest.fn() }),
    createEnvRedisAuditSpool: () => null,
    // Denied-authz auditor sink registered at service boot (src/index.ts).
    // No-op in tests — nothing asserts on the registration.
    setAuthzDenialAuditor: () => {},
    wireAuthzDenialAuditor: () => {},
    // Token-revocation reader hooks (session-invalidation option b) — stubbed
    // for parity so suites that transitively load the boot module still link.
    setTokenRevocationStore: () => {},
    createRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    createEnvRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    NotFoundError,
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    ...overrides,
  };
}
