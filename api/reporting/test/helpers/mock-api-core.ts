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
    MAX_PAGE_LIMIT: 1000,
    DEFAULT_PAGE_LIMIT: 100,
    closeLeaderLock: async () => undefined,
    loadAndRestore: async () => null,
    REPORT_INTERVALS: ['day', 'week', 'month'],
    scrubAwsIdentifiersFromString: (s: string) => s,
    scrubAwsIdentifiers: <T>(v: T): T => v,
    createScheduler: () => ({ start: () => undefined, stop: () => undefined }),
    createEnvRedisLock: () => null,
    // Billing toggle — reporting-retention's D8 gate reads it; default ON so the
    // sweep-scheduling suites behave as before. Suites override per-case.
    isBillingEnabled: () => true,
    // Faithful parseDateRange (mirrors api-core/utils/params): retention-cap.ts now
    // imports it directly, so the base mock must export it. Suites that assert on
    // the spy override it in their own apiCoreMock({ parseDateRange }) call.
    parseDateRange: (
      query: Record<string, unknown> = {},
      options: { maxRangeMs?: number; defaultDaysBack?: number } = {},
    ) => {
      const { maxRangeMs, defaultDaysBack = 30 } = options;
      const rawFrom = query.from;
      const rawTo = query.to;
      if (rawFrom !== undefined && typeof rawFrom !== 'string') return { error: '"from" must be a single ISO timestamp string' };
      if (rawTo !== undefined && typeof rawTo !== 'string') return { error: '"to" must be a single ISO timestamp string' };
      const now = Date.now();
      const fromStr = (rawFrom as string) ?? new Date(now - defaultDaysBack * 86_400_000).toISOString();
      const toStr = (rawTo as string) ?? new Date(now).toISOString();
      const fromMs = Date.parse(fromStr);
      const toMs = Date.parse(toStr);
      if (!Number.isFinite(fromMs)) return { error: '"from" is not a valid ISO timestamp' };
      if (!Number.isFinite(toMs)) return { error: '"to" is not a valid ISO timestamp' };
      if (fromMs > toMs) return { error: '"from" must be earlier than "to"' };
      if (maxRangeMs !== undefined && toMs - fromMs > maxRangeMs) {
        return { error: `Date range exceeds maximum of ${Math.floor(maxRangeMs / 86_400_000)} days` };
      }
      return { from: fromStr, to: toStr };
    },
    requireStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
    // RBAC read-permission gate factories. Behavioral so the index-wiring suite
    // can assert 403-vs-pass; provided by default so any suite loading src/index.ts
    // (which now imports requirePermission) links. Router-only suites don't hit them.
    requirePermission: (...permissions: string[]) => permissionGate(permissions, false),
    requirePermissionOrService: (...permissions: string[]) => permissionGate(permissions, true),
    // Feature-entitlement gate factory (DORA routes use requireFeature). Passthrough
    // middleware — router suites pull the withRoute handler directly, and the
    // index-wiring suite only needs the module to link.
    requireFeature: (_feature: string) => (_req: any, _res: any, next: any) => next && next(),
    // Pagination + validation helpers used by the incident/settings routes. Simple
    // behavioral stubs so router suites can drive the handlers directly.
    sendPaginatedNested: (_res: any, key: string, data: unknown, options: unknown) => ({ [key]: data, pagination: options }),
    parsePaginationParams: (q: Record<string, unknown>) => ({
      limit: Number(q?.limit) > 0 ? Number(q.limit) : 100,
      offset: Number(q?.offset) > 0 ? Number(q.offset) : 0,
    }),
    validateBody: (req: any, schema: any) => {
      const r = schema.safeParse(req?.body);
      return r.success
        ? { ok: true, value: r.data }
        : { ok: false, error: r.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    },
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
    // Remote audit client factory — kept for any module still linking it directly.
    createRemoteAuditClient: () => ({ record: () => {} }),
    createEnvRedisAuditSpool: () => null,
    // Service audit factory — src/services/audit.ts now links against this. Returns
    // the ServiceAuditClient shape: `emit` + a spool-backed `client` (RemoteAuditClient).
    createServiceAuditClient: () => ({ emit: jest.fn(), client: { record: jest.fn() } }),
    createRemoteAuditAccessor: () => ({ getAuditClient: () => ({ record: jest.fn() }), emit: jest.fn() }),
    // #5 failed-authz auditor registration (src/index.ts) — no-op in suites.
    setAuthzDenialAuditor: () => {},
    wireAuthzDenialAuditor: () => {},
    wireServiceSecurity: () => {},
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
