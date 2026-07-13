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

/** Canonical org-scoped permission identifiers (mirrors api-core ALL_PERMISSIONS). */
const ALL_PERMISSIONS: readonly string[] = [
  'pipelines:read', 'pipelines:write',
  'plugins:read', 'plugins:write',
  'compliance:read', 'compliance:write',
  'members:manage', 'roles:manage', 'invitations:manage',
  'dashboards:read', 'dashboards:write',
  'observability:read', 'observability:write',
  'reports:read',
  'messages:read', 'messages:write',
  'billing:read', 'billing:manage',
  'quotas:read',
  'registry:read', 'registry:write',
  'org:settings',
];

/** Mirrors api-core's MEMBER seed bundle (a read-heavy subset of ALL_PERMISSIONS). */
const MEMBER_PERMISSIONS: readonly string[] = [
  'pipelines:read', 'pipelines:write',
  'plugins:read', 'plugins:write',
  'compliance:read',
  'dashboards:read',
  'observability:read',
  'reports:read',
  'messages:read', 'messages:write',
  'billing:read',
  'quotas:read',
  'registry:read',
];

/**
 * Seed bundles for the built-in Roles, keyed by coarse role (mirrors api-core
 * `ROLE_PERMISSIONS`). Consumed by `seedDefaultRoles` + the backfill to
 * populate a built-in Role's own `permissions[]`. owner == admin == all.
 */
const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  member: MEMBER_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  owner: ALL_PERMISSIONS,
};

/**
 * Faithful single-source resolver (mirrors api-core `resolveUserPermissions`):
 * superadmin ⇒ ALL; otherwise exactly the union of the passed Role permissions,
 * in canonical order. No role-derived baseline.
 */
function resolveUserPermissions(assignedPermissions?: readonly string[] | null, isSuperAdmin?: boolean): string[] {
  if (isSuperAdmin) return [...ALL_PERMISSIONS];
  const set = new Set((assignedPermissions ?? []).filter((p) => ALL_PERMISSIONS.includes(p)));
  return ALL_PERMISSIONS.filter((p) => set.has(p));
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
    SYSTEM_ORG_ID: '000000000000000000000001',
    // Tier identity — organization-service / validation import these at module
    // load. A suite can override QUOTA_TIERS via `overrides` for shape-specific
    // assertions; DEFAULT_TIER stays 'developer' unless a suite overrides it.
    DEFAULT_TIER: 'developer',
    VALID_TIERS: ['developer', 'pro', 'team', 'enterprise'],
    isValidTier: (t: string) => ['developer', 'pro', 'team', 'enterprise'].includes(t),
    // Org-hierarchy traversal primitives — platform's helpers/org-hierarchy.js
    // (loaded transitively by organization-service / seats.js) imports these.
    // Default to a FLAT resolution: root = self, subtree = [self]. A suite can
    // override to exercise a real hierarchy.
    MAX_ORG_DEPTH: 16,
    toOrgIdString: (v: unknown) => (v == null ? undefined : String(v)),
    resolveOrgLineageWith: async (orgId: string) => ({ rootOrgId: orgId }),
    resolveRootOrgIdWith: async (orgId: string) => orgId,
    isAncestorOrgWith: async () => false,
    expandOrgScopeWith: async (orgId: string) => [orgId],
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    NotFoundError,
    // Permission catalog — roles-service / organization-service import these to
    // validate/filter group-granted permissions. Mirrors api-core's real list so
    // the mock's `isValidPermission` accepts exactly the canonical identifiers.
    ALL_PERMISSIONS,
    // Seed bundles for built-in Roles + the single-source resolver. seedDefaultRoles
    // / the backfill read ROLE_PERMISSIONS; token issuance reads resolveUserPermissions.
    ROLE_PERMISSIONS,
    resolveUserPermissions,
    isValidPermission: (value: string) => ALL_PERMISSIONS.includes(value),
    // Fine-grained RBAC helpers (faithful to api-core): superadmins hold all;
    // otherwise the resolved `permissions` claim must include it.
    userHasPermission: (req: { user?: { isSuperAdmin?: boolean; permissions?: string[] } }, perm: string) =>
      req?.user?.isSuperAdmin === true || (Array.isArray(req?.user?.permissions) && req.user!.permissions!.includes(perm)),
    requirePermission: (...perms: string[]) => (req: { user?: { isSuperAdmin?: boolean; permissions?: string[] } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (req?.user?.isSuperAdmin === true || (Array.isArray(req?.user?.permissions) && perms.some((p) => req.user!.permissions!.includes(p)))) return next();
      res.status(403).json({ success: false, message: 'INSUFFICIENT_PERMISSIONS' });
    },
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    // Service-to-service auth header (checkTierOvercap mints one to read pooled
    // usage from the quota service). Tests only need a stable stub value.
    getServiceAuthHeader: () => 'Bearer service-token',
    // Pagination parser (controllers migrated off the local shim to this).
    parsePaginationParams: (q: Record<string, unknown> = {}) => {
      const toInt = (v: unknown, d: number) => {
        const n = parseInt(String(v ?? ''), 10);
        return Number.isFinite(n) && n >= 0 ? n : d;
      };
      return { limit: Math.min(toInt(q.limit, 10), 100), offset: toInt(q.offset, 0) };
    },
    ...overrides,
  };
}
