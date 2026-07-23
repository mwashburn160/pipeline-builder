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

/**
 * Behavioral stub for api-core's `requirePermission` / `requirePermissionOrService`
 * gate factories. Returns a tagged Express middleware that passes a superadmin or a
 * user holding one of `permissions` (and, when `allowService`, a `service:*`
 * principal without any permission), and 403s otherwise. The `__permission` /
 * `__allowService` tags let the index-wiring suite locate the mounted gate.
 */
function permissionGate(permissions: string[], allowService: boolean) {
  const gate = (req: any, res: any, next: any) => {
    const user = req?.user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const isService = typeof user.sub === 'string' && user.sub.startsWith('service:');
    if (allowService && isService) return next();
    const held: string[] = Array.isArray(user.permissions) ? user.permissions : [];
    if (user.isSuperAdmin === true || permissions.some((p) => held.includes(p))) return next();
    return res.status(403).json({ error: `Missing required permission: ${permissions.join(' or ')}` });
  };
  (gate as any).__permission = permissions.join(' or ');
  (gate as any).__allowService = allowService;
  return gate;
}

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
    // RBAC read-permission gate factories. Behavioral so the index-wiring suite
    // can assert 403-vs-pass; provided by default so any suite loading src/index.ts
    // (which now imports requirePermission) links. Router-only suites don't hit them.
    requirePermission: (...permissions: string[]) => permissionGate(permissions, false),
    requirePermissionOrService: (...permissions: string[]) => permissionGate(permissions, true),
    // Shared org-descendants resolver imported by src/helpers.ts (resolveOrgRollup).
    // A stub is enough for the module to link; suites that exercise the rollup
    // mock resolveOrgRollup itself at the helpers layer.
    fetchOrgDescendants: jest.fn(),
    SYSTEM_ORG_ID: '000000000000000000000001',
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    // Remote audit client factory — src/services/audit.ts links against this.
    createRemoteAuditClient: () => ({ record: () => {} }),
    createEnvRedisAuditSpool: () => null,
    // #5 failed-authz auditor registration (src/index.ts) — no-op in suites.
    setAuthzDenialAuditor: () => {},
    wireAuthzDenialAuditor: () => {},
    // Token-revocation reader hooks (session-invalidation) — stubbed for parity
    // so suites that transitively load the boot module still link.
    setTokenRevocationStore: () => {},
    createEnvRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    NotFoundError,
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    ...overrides,
  };
}
