// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform's `@pipeline-builder/api-core` mock.
 *
 * The shared primitives (REAL api-core base, logger stub, `ErrorCode` proxy,
 * error classes, the `requireInternalService` gate) live in
 * `@pipeline-builder/api-core/testing`. Platform uses
 * `primitiveApiCoreMock` rather than `baseApiCoreMock` on purpose: it keeps
 * api-core's REAL pagination/report constants and supplies its own (large)
 * identity/tier/permission default set, below.
 */
import { jest } from '@jest/globals';
// Shared tier fixture — deep path is NOT intercepted by the api-core module mock
// (see tier-mock.ts). Sources the tier NAME LIST from the real VALID_TIERS.
// Deep-import the REAL canonical constants from side-effect-free submodules (NOT
// the mocked barrel — same trick as tier-mock: deep paths aren't intercepted by
// the api-core module mock, and these modules have only type-imports so loading
// them pulls in no config/secrets). Re-exporting the real values instead of
// hand-copying them makes drift STRUCTURALLY impossible.
import { ALL_FEATURE_FLAGS, TIER_FEATURES } from '@pipeline-builder/api-core/lib/types/feature-flags.js';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  SUPERADMIN_ONLY_PERMISSIONS,
  SYSTEM_ORG_ONLY_PERMISSIONS,
  ECOSYSTEM_MANAGER_PERMISSIONS,
  ORG_ASSIGNABLE_PERMISSIONS,
  isOrgAssignablePermission,
  isSystemOrgOnlyPermission,
  resolveUserPermissions,
} from '@pipeline-builder/api-core/lib/types/permissions.js';
import { REMOTE_AUDIT_ACTIONS } from '@pipeline-builder/api-core/lib/types/remote-audit-actions.js';
import { scrubAwsIdentifiers } from '@pipeline-builder/api-core/lib/utils/aws-scrub.js';
import {
  MockNotFoundError,
  loggerMock,
  mockErrorCode,
  primitiveApiCoreMock,
  withInternalServiceGate,
  MOCK_TIER_NAMES,
  mockIsValidTier,
  mockQuotaTiers,
} from '@pipeline-builder/api-core/testing';

export { loggerMock };

/**
 * The REAL api-core exports, resolved HERE (not inside the shared factory):
 * `requireActual` on an ESM barrel only succeeds while nothing else is
 * mid-`import()` of it, and this module — a static import of every suite that
 * uses it, evaluated before the suite's `await import(SUT)` — is the one point
 * where that reliably holds.
 */
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;

/** Platform-specific defaults layered over the shared primitives. */
const platformDefaults = (): Record<string, unknown> => ({
  SYSTEM_ORG_ID: '000000000000000000000001',
  SYSTEM_ORG_SLUG: 'system',
  // Tier identity — organization-service / validation import these at module
  // load. A suite can override QUOTA_TIERS via `overrides` for shape-specific
  // assertions; DEFAULT_TIER stays 'developer' unless a suite overrides it.
  DEFAULT_TIER: 'developer',
  // Opt-out default-on, mirroring the real api-core (BILLING_ENABLED != 'false').
  isBillingEnabled: () => true,
  VALID_TIERS: [...MOCK_TIER_NAMES],
  STANDARD_TIERS: MOCK_TIER_NAMES.filter((t) => t !== 'unlimited'),
  TEAM_CAPABLE_TIERS: ['team', 'enterprise', 'unlimited'],
  tierAllowsTeams: (t: string | undefined | null) => !!t && ['team', 'enterprise', 'unlimited'].includes(t),
  isValidTier: mockIsValidTier,
  // Minimal default so any suite importing the real quota/service chain resolves
  // the `QUOTA_TIERS` binding at module load; a suite override wins.
  QUOTA_TIERS: mockQuotaTiers({
    developer: { seats: 1 },
    pro: { seats: 3 },
    team: { seats: 10 },
    enterprise: { seats: -1 },
  }),
  // Tier → default feature set — the REAL api-core TIER_FEATURES (deep-imported).
  TIER_FEATURES,
  // Canonical feature-flag registry (the REAL ALL_FEATURE_FLAGS).
  ALL_FEATURE_FLAGS,
  isValidFeatureFlag: (v: string) => (ALL_FEATURE_FLAGS as readonly string[]).includes(v),
  // Resolve a tier + account-feature entitlements → feature list (sync).
  resolveUserFeatures: (_tier?: unknown, _opts?: { accountFeatures?: string[] }) => (_opts?.accountFeatures ?? []),
  // Org-hierarchy traversal primitives — platform's helpers/org-hierarchy.js
  // imports these. Default to a FLAT resolution: root = self, subtree = [self].
  MAX_ORG_DEPTH: 16,
  toOrgIdString: (v: unknown) => (v == null ? undefined : String(v)),
  resolveOrgLineageWith: async (orgId: string) => ({ rootOrgId: orgId }),
  resolveRootOrgIdWith: async (orgId: string) => orgId,
  isAncestorOrgWith: async () => false,
  expandOrgScopeWith: async (orgId: string) => [orgId],

  ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
  PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  NotFoundError: MockNotFoundError,
  // Per-org secret encryption (utils/secret-encryption). Reversible base64
  // round-trip so a suite that DOES exercise IdP secrets still behaves.
  encryptSecret: async (plaintext: string, orgId: string) => ({ v: 1, orgId, data: Buffer.from(String(plaintext)).toString('base64') }),
  decryptSecret: async (blob: { data?: string }) => Buffer.from(String(blob?.data ?? ''), 'base64').toString('utf8'),
  isEncryptedBlob: (v: unknown) => !!v && typeof v === 'object' && 'data' in (v as object),
  // Leader-lock (services/leader-lock). Default: ALWAYS the leader — run the
  // callback and report acquired, so a suite's sweep logic executes.
  withLeaderLock: async (_redis: unknown, _key: string, _ttlMs: number, fn: () => Promise<void>) => { await fn(); return true; },
  // SSRF guards (utils/ssrf). `assertSafeUrl` is VALIDATION ONLY (create/update
  // time) and defaults to PERMISSIVE. Outbound requests go through `safeFetch`,
  // which resolves, pins the vetted IP and refuses redirects; a suite that
  // exercises a guarded send overrides it.
  assertSafeUrl: async () => undefined,
  // Permission catalog — role-authority / role-crud / organization-service
  // import these to validate/filter role-granted permissions.
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  resolveUserPermissions,
  isValidPermission: (value: string) => (ALL_PERMISSIONS as readonly string[]).includes(value),
  // Registry + ecosystem carve-outs for custom-Role authoring, and the system
  // org's Ecosystem Manager seed bundle (the REAL values/predicates).
  SUPERADMIN_ONLY_PERMISSIONS,
  SYSTEM_ORG_ONLY_PERMISSIONS,
  ECOSYSTEM_MANAGER_PERMISSIONS,
  ORG_ASSIGNABLE_PERMISSIONS,
  isOrgAssignablePermission,
  isSystemOrgOnlyPermission,
  // Session-revocation PUBLISHER contract (helpers/session-revocation.ts).
  publishTokenRevocation: jest.fn(async () => undefined),
  publishSessionRevocation: jest.fn(async () => true),
  // Platform's Redis client is built through the SAME env resolution the services
  // use. Default: no Redis configured (null), so suites run the in-memory paths.
  createEnvRedisClient: jest.fn(() => null),
  createRedisTokenRevocationStore: jest.fn(() => ({ getCurrentVersion: jest.fn(async () => null) })),
  // System-admin check (faithful to api-core): authority is carried solely by
  // the JWT's `isSuperAdmin` flag.
  isSystemAdmin: (req: { user?: { isSuperAdmin?: boolean } }) => req?.user?.isSuperAdmin === true,
  // Service-principal check (faithful to api-core).
  isServicePrincipal: (req: { user?: { principalType?: string } }) => req?.user?.principalType === 'service',
  isServicePrincipalNamed: (req: { user?: { principalType?: string; sub?: string } }, name: string) =>
    req?.user?.principalType === 'service' && req?.user?.sub === `service:${name}`,
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
  isRemoteAuditAction: (value: string) => (REMOTE_AUDIT_ACTIONS as readonly string[]).includes(value),
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
  // usage from the quota service).
  getServiceAuthHeader: () => 'Bearer service-token',
  // Query-string collapser (mirrors api-core).
  parseQueryString: (v: unknown) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
    return undefined;
  },
  ErrorCode: mockErrorCode,
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...platformDefaults(), ...overrides };
  return withInternalServiceGate(primitiveApiCoreMock(actualApiCore, merged), overrides);
}
