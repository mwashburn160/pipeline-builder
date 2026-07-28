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

/** Canonical feature-flag identifiers (mirrors api-core ALL_FEATURE_FLAGS). */
const ALL_FEATURE_FLAGS: readonly string[] = [
  'priority_support', 'ai_generation', 'bulk_operations', 'custom_integrations',
  'audit_log', 'sso', 'advanced_reporting',
];

/** Mirrors api-core's SUPERADMIN_ONLY_PERMISSIONS (the shared image registry). */
const SUPERADMIN_ONLY_PERMISSIONS: readonly string[] = ['registry:read', 'registry:write'];

/** Mirrors api-core's ORG_ASSIGNABLE_PERMISSIONS (ALL minus the superadmin-only). */
const ORG_ASSIGNABLE_PERMISSIONS: readonly string[] =
  ALL_PERMISSIONS.filter((p) => !SUPERADMIN_ONLY_PERMISSIONS.includes(p));

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

/**
 * Faithful mirror of api-core `REMOTE_AUDIT_ACTIONS` — the subset a non-platform
 * service may emit through `POST /audit/events`. The audit ingest route validates
 * against this (NOT the full platform union), so any suite loading the route needs
 * it. Kept as a superset-safe copy; the real drift guard lives in
 * `audit-remote-subset.test.ts` (which loads the REAL api-core).
 */
const REMOTE_AUDIT_ACTIONS: readonly string[] = [
  'plugin.build.completed', 'plugin.build.failed', 'plugin.build.timeout',
  'plugin.delete', 'plugin.upload', 'plugin.deploy',
  'pipeline.create', 'pipeline.update', 'pipeline.delete',
  'pipeline.execution.start', 'pipeline.execution.cancel',
  'quota.reset', 'quota.limit.update',
  'compliance.exemption.approve', 'compliance.rule.toggle', 'compliance.scan.cancel',
  'registry.gc', 'registry.image.delete',
  'authz.denied',
];

/**
 * Faithful mirror of api-core `scrubAwsIdentifiers` — deep-redacts AWS account
 * ids (bare 12-digit tokens incl. the account segment of any ARN) and any
 * account-named key. audit-chain.ts applies this at the append choke point, so
 * suites that mock api-core and load the appender need it to behave for real.
 */
const AWS_ACCOUNT_ID_RE = /(?<!\d)\d{12}(?!\d)/g;
const ACCOUNT_KEY_RE = /account/i;
function scrubAwsIdentifiers<T>(value: T): T {
  if (typeof value === 'string') return value.replace(AWS_ACCOUNT_ID_RE, '[REDACTED]') as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubAwsIdentifiers(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = (ACCOUNT_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number'))
        ? '[REDACTED]'
        : scrubAwsIdentifiers(v);
    }
    return out as T;
  }
  return value;
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
    SYSTEM_ORG_SLUG: 'system',
    // Tier identity — organization-service / validation import these at module
    // load. A suite can override QUOTA_TIERS via `overrides` for shape-specific
    // assertions; DEFAULT_TIER stays 'developer' unless a suite overrides it.
    DEFAULT_TIER: 'developer',
    VALID_TIERS: ['developer', 'pro', 'team', 'enterprise'],
    isValidTier: (t: string) => ['developer', 'pro', 'team', 'enterprise'].includes(t),
    // Minimal default so any suite importing the real quota/service chain resolves
    // the `QUOTA_TIERS` binding at module load; a suite override wins for
    // shape-specific assertions. All non-seat dims are -1 (unlimited) — enough to
    // load; tests that assert reseed shapes pass their own QUOTA_TIERS.
    QUOTA_TIERS: (() => {
      const limits = (seats: number) => ({
        seats,
        plugins: -1,
        pipelines: -1,
        apiCalls: -1,
        aiCalls: -1,
        storageBytes: -1,
        dashboards: -1,
        alertRules: -1,
        alertDestinations: -1,
        idpConfigs: -1,
      });
      return {
        developer: { label: 'Developer', limits: limits(1) },
        pro: { label: 'Pro', limits: limits(3) },
        team: { label: 'Team', limits: limits(10) },
        enterprise: { label: 'Enterprise', limits: limits(-1) },
      };
    })(),
    // Tier → default feature set (mirrors api-core TIER_FEATURES). user-admin's
    // feature-override entitlement gate reads this to decide which features an org
    // admin may enable without a purchase.
    TIER_FEATURES: {
      developer: [],
      pro: ['priority_support', 'ai_generation', 'bulk_operations'],
      team: ['priority_support', 'ai_generation', 'bulk_operations', 'audit_log', 'sso'],
      enterprise: ['priority_support', 'ai_generation', 'bulk_operations', 'custom_integrations', 'audit_log', 'sso'],
    },
    // Canonical feature-flag registry (mirrors api-core ALL_FEATURE_FLAGS /
    // isValidFeatureFlag). The seat-limit controller whitelists the caller's
    // `features[]` against this before persisting, so any suite loading that
    // controller needs the export to link + behave for real.
    ALL_FEATURE_FLAGS,
    isValidFeatureFlag: (v: string) => ALL_FEATURE_FLAGS.includes(v),
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
    // SSRF guard (utils/ssrf). Default is PERMISSIVE (resolves) so suites that
    // don't exercise the guard aren't forced to mock DNS; a suite testing the
    // guarded webhook path overrides `assertSafeUrl` to reject. `isRefusedRedirect`
    // + `SSRF_FETCH_INIT` mirror api-core so the redirect handling behaves for real.
    assertSafeUrl: async () => undefined,
    isRefusedRedirect: (resp: { type?: string; status: number }) =>
      resp?.type === 'opaqueredirect' || (resp?.status >= 300 && resp?.status < 400),
    SSRF_FETCH_INIT: { redirect: 'manual' as const },
    // Permission catalog — roles-service / organization-service import these to
    // validate/filter group-granted permissions. Mirrors api-core's real list so
    // the mock's `isValidPermission` accepts exactly the canonical identifiers.
    ALL_PERMISSIONS,
    // Seed bundles for built-in Roles + the single-source resolver. seedDefaultRoles
    // / the backfill read ROLE_PERMISSIONS; token issuance reads resolveUserPermissions.
    ROLE_PERMISSIONS,
    resolveUserPermissions,
    isValidPermission: (value: string) => ALL_PERMISSIONS.includes(value),
    // Registry carve-out for custom-Role authoring: roles-service imports these
    // to reject superadmin-only permissions in a user-supplied permission set.
    SUPERADMIN_ONLY_PERMISSIONS,
    ORG_ASSIGNABLE_PERMISSIONS,
    isOrgAssignablePermission: (p: string) => !SUPERADMIN_ONLY_PERMISSIONS.includes(p),
    // Session-revocation PUBLISHER contract (helpers/session-revocation.ts).
    // Default no-op spies; a suite exercising publishing overrides them.
    publishTokenRevocation: jest.fn(async () => undefined),
    createRedisTokenRevocationStore: jest.fn(() => ({ getCurrentVersion: jest.fn(async () => null) })),
    // System-admin check (faithful to api-core): authority is carried solely by
    // the JWT's `isSuperAdmin` flag. Used by tenant-binding gates (audit ingest,
    // notify-email) to let a sysadmin service token target any org.
    isSystemAdmin: (req: { user?: { isSuperAdmin?: boolean } }) => req?.user?.isSuperAdmin === true,
    // Audit ingest allow-list + AWS-id scrub (audit-chain / audit route consume
    // these). Faithful to api-core so the anti-forgery gate and details scrub
    // behave for real under the mock.
    REMOTE_AUDIT_ACTIONS,
    isRemoteAuditAction: (value: string) => REMOTE_AUDIT_ACTIONS.includes(value),
    scrubAwsIdentifiers,
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
    // Query-string collapser (mirrors api-core): normalize Express's
    // `string | string[] | ParsedQs` to `string | undefined` (first value wins).
    parseQueryString: (v: unknown) => {
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
      return undefined;
    },
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
