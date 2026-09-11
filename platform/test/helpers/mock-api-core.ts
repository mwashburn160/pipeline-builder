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
// Shared tier fixture — deep path is NOT intercepted by the api-core module mock
// (see tier-mock.ts). Sources the tier NAME LIST from the real VALID_TIERS.
import { MOCK_TIER_NAMES, mockIsValidTier, mockQuotaTiers } from '@pipeline-builder/api-core/lib/testing/tier-mock.js';
// Deep-import the REAL canonical constants from side-effect-free submodules (NOT
// the mocked barrel — same trick as tier-mock: deep paths aren't intercepted by
// the api-core module mock, and these modules have only type-imports so loading
// them pulls in no config/secrets). Re-exporting the real values instead of
// hand-copying them makes drift STRUCTURALLY impossible — a new permission /
// feature / audit-action added to api-core is reflected here automatically, so it
// can never cause the "does not provide an export named X" link failures or the
// silent value-drift that a mirrored copy invites. mock-parity.test.ts backstops
// this.
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  SUPERADMIN_ONLY_PERMISSIONS,
  ORG_ASSIGNABLE_PERMISSIONS,
  resolveUserPermissions,
} from '@pipeline-builder/api-core/lib/types/permissions.js';
import { ALL_FEATURE_FLAGS, TIER_FEATURES } from '@pipeline-builder/api-core/lib/types/feature-flags.js';
import { scrubAwsIdentifiers } from '@pipeline-builder/api-core/lib/utils/aws-scrub.js';
import { REMOTE_AUDIT_ACTIONS } from '@pipeline-builder/api-core/lib/services/remote-audit-client.js';

/** The 4-method logger stub every suite repeats; a fresh set of spies per call. */
export const loggerMock = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

/** Mirrors api-core: `ErrorCode.ANY_CODE` resolves to the string `'ANY_CODE'`. */
const ErrorCode = new Proxy({}, { get: (_t, key) => key }) as Record<string, string>;

// ALL_PERMISSIONS, ROLE_PERMISSIONS, SUPERADMIN_ONLY_PERMISSIONS,
// ORG_ASSIGNABLE_PERMISSIONS, resolveUserPermissions, ALL_FEATURE_FLAGS,
// TIER_FEATURES, REMOTE_AUDIT_ACTIONS, and scrubAwsIdentifiers are now the REAL
// api-core values (deep-imported above) — no hand-copies to drift.

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
    // Opt-out default-on, mirroring the real api-core (BILLING_ENABLED != 'false').
    // auth-service reads this to pick the system org's tier; a suite exercising the
    // billing-off path overrides it to `() => false`.
    isBillingEnabled: () => true,
    VALID_TIERS: [...MOCK_TIER_NAMES],
    STANDARD_TIERS: MOCK_TIER_NAMES.filter((t) => t !== 'unlimited'),
    TEAM_CAPABLE_TIERS: ['team', 'enterprise', 'unlimited'],
    tierAllowsTeams: (t: string | undefined | null) => !!t && ['team', 'enterprise', 'unlimited'].includes(t),
    isValidTier: mockIsValidTier,
    // Minimal default so any suite importing the real quota/service chain resolves
    // the `QUOTA_TIERS` binding at module load; a suite override wins for
    // shape-specific assertions. Built from the shared fixture (complete over the
    // real tier list); only the per-tier `seats` differ, so all other dims default
    // to uncapped. Suites that assert reseed shapes pass their own QUOTA_TIERS.
    QUOTA_TIERS: mockQuotaTiers({
      developer: { seats: 1 },
      pro: { seats: 3 },
      team: { seats: 10 },
      enterprise: { seats: -1 },
    }),
    // Tier → default feature set — the REAL api-core TIER_FEATURES (deep-imported).
    // user-admin's feature-override entitlement gate reads this to decide which
    // features an org admin may enable without a purchase.
    TIER_FEATURES,
    // Canonical feature-flag registry (the REAL ALL_FEATURE_FLAGS). The seat-limit
    // controller whitelists the caller's `features[]` against this before persisting.
    ALL_FEATURE_FLAGS,
    isValidFeatureFlag: (v: string) => (ALL_FEATURE_FLAGS as readonly string[]).includes(v),
    // Resolve a tier + account-feature entitlements → feature list (sync). Pulled
    // in via helpers/sso-enforcement (loaded transitively by controllers/auth).
    // Default: no extra features (not SSO-forced); a suite testing entitlement
    // gating overrides this to include e.g. 'sso'.
    resolveUserFeatures: (_tier?: unknown, _opts?: { accountFeatures?: string[] }) => (_opts?.accountFeatures ?? []),
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
    
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    NotFoundError,
    // Per-org secret encryption (utils/secret-encryption). Pulled in transitively
    // via services/org-idp-service → utils/secret-blob (e.g. any suite importing
    // controllers/auth, which now wires SSO enforcement). Reversible base64
    // round-trip so a suite that DOES exercise IdP secrets still behaves; one
    // testing real crypto overrides them.
    encryptSecret: (plaintext: string, orgId: string) => ({ v: 1, orgId, data: Buffer.from(String(plaintext)).toString('base64') }),
    decryptSecret: (blob: { data?: string }) => Buffer.from(String(blob?.data ?? ''), 'base64').toString('utf8'),
    isEncryptedBlob: (v: unknown) => !!v && typeof v === 'object' && 'data' in (v as object),
    // SSRF guard (utils/ssrf). Default is PERMISSIVE (resolves) so suites that
    // don't exercise the guard aren't forced to mock DNS; a suite testing the
    // guarded webhook path overrides `assertSafeUrl` to reject. `isRefusedRedirect`
    // + `SSRF_FETCH_INIT` mirror api-core so the redirect handling behaves for real.
    // Leader-lock (services/leader-lock). Platform's background sweeps (org-purge,
    // invitation-reaper, billing-reconcile, scraper) now run under it. Default:
    // ALWAYS the leader — run the callback and report acquired, so a suite's sweep
    // logic executes; a suite testing the lock itself overrides this.
    withLeaderLock: async (_redis: unknown, _key: string, _ttlMs: number, fn: () => Promise<void>) => { await fn(); return true; },
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
    // Service-principal check (faithful to api-core): a service token's `sub`
    // starts with `service:`. Used by internal read gates (org parent/members).
    isServicePrincipal: (req: { user?: { sub?: string } }) => req?.user?.sub?.startsWith('service:') ?? false,
    // Route-param extractor (faithful to api-core): first value of a param.
    getParam: (params: Record<string, unknown>, key: string) => {
      const v = params?.[key];
      if (v === undefined) return undefined;
      return Array.isArray(v) ? v[0] : v;
    },
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
