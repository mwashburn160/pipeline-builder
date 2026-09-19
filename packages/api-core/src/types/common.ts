// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Permission } from './permissions.js';
import type { QuotaTier } from './quota-tiers.js';

/**
 * Capability scope catalog for machine/automation tokens. A scoped token carries
 * exactly one of these instead of role-based permissions; endpoints that accept a
 * scoped identity check it via `hasScope`. Kept a closed union (mirroring
 * {@link Permission}) so a typo on either the mint or the check side is a compile
 * error. Add a value here when introducing a new scoped-token surface.
 *
 * - `reporting:ingest` — the AWS event-ingestion Lambda's writes (`/reports/events`,
 *   `/reports/ingest-health`) and the incident webhook.
 * - `registry:push`    — `docker push` into the owning org's own namespace via
 *   image-registry's `/token` endpoint. Grants the raw-image write that
 *   `plugins:write` grants a person, and nothing else: a scoped token carries no
 *   permissions, so it can neither read the API nor push outside its org.
 * - `scim`             — an identity provider's SCIM 2.0 client (3b) driving
 *   `/scim/v2/Users` and `/scim/v2/Groups` for the key's OWN org. It provisions
 *   and deactivates memberships and moves people between directory groups; it
 *   can never read or write anything else, and — because a scoped token carries
 *   no permissions — it cannot author the group → Role rules its syncs resolve
 *   through. Only a service-account key may carry it; a person's token never does.
 */
export type TokenScope = 'reporting:ingest' | 'registry:push' | 'scim';

/**
 * Runtime catalog of {@link TokenScope} (a union is erased at runtime). This is
 * the ONE allowlist every mint path validates against — platform's key/token
 * issue routes included — so a new scope is added in exactly one place.
 */
export const TOKEN_SCOPES: readonly TokenScope[] = ['reporting:ingest', 'registry:push', 'scim'];

/**
 * What kind of principal a token speaks for. Auth decisions branch on this claim
 * — never on the shape of `sub` or on which optional claims happen to be present.
 *
 * - `user`            — a person (session, machine session, PAT or impersonation).
 * - `service_account` — a non-human account owned by ONE org, holding org Roles
 *                       and authenticating with a `pb_sa_…` key exchanged at
 *                       platform. Never satisfies an assurance/step-up gate.
 * - `service`         — an internal Pipeline Builder service ({@link signServiceToken}).
 */
export type PrincipalType = 'user' | 'service_account' | 'service';

/**
 * How a token is used. `access` is a session-style access token (interactive,
 * machine-session or service); `api_key` is a standalone credential tracked by
 * its own record — a Personal Access Token or a service-account key, named by
 * `jti`.
 */
export type TokenUse = 'access' | 'api_key';

/**
 * Authentication methods (`amr`, RFC 8176 style) that established a user's
 * session. `pwd` password sign-in; `oauth` social sign-in (Google, GitHub …);
 * `sso` per-org OIDC single sign-on; `webauthn` a passkey (WebAuthn assertion
 * with user verification); `stepup` a step-up re-verification token; `mfa` a
 * second factor was presented as well — today an authenticator-app code (TOTP)
 * or one of its recovery codes, so it appears ALONGSIDE the method that
 * identified the user (`['pwd', 'mfa']`), never on its own.
 */
export type AuthMethod = 'pwd' | 'oauth' | 'sso' | 'webauthn' | 'stepup' | 'mfa';

/**
 * Authenticator assurance level of the session a token speaks for (#8).
 *
 * - `1` — one factor: a password, a social sign-in, or SSO through an IdP the
 *   org has NOT marked as enforcing MFA.
 * - `2` — MFA-grade: a passkey asserted with user verification, a password plus
 *   an authenticator-app code, or SSO through an IdP the org HAS marked as
 *   enforcing MFA (providers don't send `amr` reliably, so the org's own
 *   statement about its IdP is the signal).
 *
 * Fixed when the session is opened and stored on its refresh-session slot, so
 * refresh / renewal / switch-org copy it verbatim and can never RAISE it —
 * earning aal 2 always means authenticating again with a second factor.
 */
export type AssuranceLevel = 1 | 2;

/** Runtime catalogs for the claim unions above (a union is erased at runtime). */
export const PRINCIPAL_TYPES: readonly PrincipalType[] = ['user', 'service_account', 'service'];
export const TOKEN_USES: readonly TokenUse[] = ['access', 'api_key'];
export const AUTH_METHODS: readonly AuthMethod[] = ['pwd', 'oauth', 'sso', 'webauthn', 'stepup', 'mfa'];

/**
 * Quota type identifiers.
 *
 * - `plugins` / `pipelines` — count of created entities
 * - `apiCalls` — generic API call count (read-heavy paths)
 * - `aiCalls` — AI provider invocations (counted separately because each call
 *   has external dollar cost; sized smaller than apiCalls per tier)
 * - `storageBytes` — registry storage budget per org. Unlike the others
 *   (which count discrete events), this is a measured total recomputed
 *   on demand. Incremented by the image-registry's push-gate before
 *   issuing a token whose scope includes `push`; the GC scheduler
 *   eventually frees the bytes, then the next push-gate check reads
 *   the lower value. NOT a counter-style quota in the sense of
 *   `incrementUsage` — the registry pushes the measured total via
 *   `updateLimits`/`resetUsage` flows. Tier limits are bytes.
 * - `dashboards` / `alertRules` / `alertDestinations` / `idpConfigs` —
 *   resource-count quotas added to close per-org DoS surfaces in the
 *   user-editable feature tables. Without these caps a single org could
 *   spam thousands of dashboards / rules and bloat the shared Postgres /
 *   Mongo working sets. Counted at create time; decremented on delete.
 */
// NOTE: `seats` is intentionally NOT here. It's a tier limit (QuotaTierLimits)
// enforced by comparing the org's LIVE member count at invite time — not an
// incrementing per-period counter like the consumable quotas below.
export type QuotaType =
  | 'plugins' | 'pipelines' | 'apiCalls' | 'aiCalls' | 'storageBytes'
  | 'dashboards' | 'alertRules' | 'alertDestinations' | 'idpConfigs';

/**
 * Valid quota type values.
 */
export const VALID_QUOTA_TYPES = [
  'plugins', 'pipelines', 'apiCalls', 'aiCalls', 'storageBytes',
  'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs',
] as const;

/**
 * Type guard to check if a value is a valid QuotaType.
 *
 * @param value - Value to check
 * @returns True if value is a valid QuotaType
 *
 * @example
 * ```typescript
 * if (isValidQuotaType(req.body.quotaType)) {
 *   // quotaType is guaranteed to be QuotaType
 * }
 * ```
 */
export function isValidQuotaType(value: unknown): value is QuotaType {
  return typeof value === 'string' && VALID_QUOTA_TYPES.includes(value as QuotaType);
}

/**
 * Result from quota check operation.
 */
export interface QuotaCheckResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Maximum quota limit (-1 for unlimited) */
  limit: number;
  /** Current usage count */
  used: number;
  /** Remaining quota (-1 for unlimited) */
  remaining: number;
  /** ISO timestamp when quota resets */
  resetAt: string;
  /** Whether quota is unlimited */
  unlimited: boolean;
  /**
   * True ONLY when this result is the fail-open sentinel returned because the
   * quota service was unreachable / returned non-ok (not a real quota reading).
   * Lets fail-closed callers (e.g. the registry storage push-gate) distinguish
   * an outage from a genuine `limit: -1` (unlimited) org. Absent on real results.
   */
  failOpen?: boolean;
}

/**
 * Quota information for error responses.
 */
export interface QuotaInfo {
  type: QuotaType;
  limit: number;
  used: number;
  remaining: number;
}

/**
 * Standard API success response.
 */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  statusCode: number;
  data?: T;
  message?: string;
}

/**
 * Standard API error response.
 */
export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  message: string;
  code?: string;
  details?: unknown;
  quota?: QuotaInfo;
}

/**
 * Combined API response type.
 */
export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * JWT payload from access tokens.
 *
 * Users can belong to multiple organizations. The token is scoped to one
 * active organization at a time. The `role` field is the user's per-org
 * role in that organization (from the UserOrganization junction collection),
 * and `isAdmin` is derived as `role === 'admin' || role === 'owner'`.
 *
 * Use `POST /auth/switch-org` to change the active organization, which
 * re-issues tokens with the new org's role and context.
 */
/**
 * Coarse per-org membership label, DERIVED from the Roles a user is assigned
 * (the highest `grantsRole` among them; `owner` is set only by ownership
 * transfer). It is a display/authority label — driving `isAdmin`, ownership,
 * and seat accounting — NOT a permission source. Effective permissions come
 * solely from the user's assigned Roles (see `resolveUserPermissions`). Not a
 * global role.
 */
export type OrgRole = 'owner' | 'admin' | 'member';

export interface JwtPayload {
  /** User ID (subject) */
  sub: string;
  /** Username */
  username: string;
  /** User email */
  email: string;
  /** Which kind of principal this token speaks for (see {@link PrincipalType}). */
  principalType: PrincipalType;
  /** How the token is used (see {@link TokenUse}); PATs are `api_key`. */
  token_use: TokenUse;
  /**
   * Methods that authenticated the session (user principals). Kept on the
   * refresh-session slot, so refresh / renew / switch-org carry it unchanged.
   * Absent on service tokens.
   */
  amr?: AuthMethod[];
  /** Assurance level (user principals). Never raised by refresh / renew / switch-org. */
  aal?: AssuranceLevel;
  /** Epoch seconds of the sign-in that established the session (user principals).
   *  Never reset by refresh / renew / switch-org. */
  auth_time?: number;
  /**
   * The active org REQUIRES MFA and its grace period has passed (#8).
   *
   * Carried as a claim so no service has to look the policy up: the org policy
   * is enforced where the token is ISSUED (a session scoped to such an org gets
   * `aal: 2` or is refused), and this claim is the record of that decision, for
   * UI copy and audit rather than for a second enforcement point.
   */
  mfaRequired?: boolean;
  /**
   * BOOTSTRAP-ADMIN EXCEPTION (#8, revision 4). Set only on a session opened by
   * the install's bootstrap admin (`BOOTSTRAP_SUPERADMIN_EMAILS`, system org)
   * while they still have no enrolled factor. Such a session is `aal: 1` and may
   * reach ONLY enrolment, sign-out and the routes `init-platform.sh` calls;
   * every other service refuses it outright (see `requireAuth`). The exception
   * closes permanently at the first enrolment and never reopens.
   */
  mfaEnrollmentPending?: boolean;
  /** Per-org role in the active organization ('owner' | 'admin' | 'member'). Not a global role. */
  role: OrgRole;
  /** Derived: true when role is 'admin' or 'owner' in the active organization */
  isAdmin?: boolean;
  /**
   * Resolved fine-grained permissions for the active org/team — the union of
   * the permissions carried by every Role the user is assigned (see
   * `resolveUserPermissions`). Absent on machine/scoped tokens. Superadmins are
   * granted all permissions implicitly and may omit this. Endpoints enforce via
   * `requirePermission(...)`.
   */
  permissions?: Permission[];
  /**
   * Global super-admin flag (cross-org). When `true`, the user is treated
   * as a system administrator regardless of which org they're currently
   * acting under. This is the SOLE signal for sysadmin authority — the old path
   * (membership in the well-known "system" org with role admin/owner) has been
   * removed because it conflated "Pipeline Builder operator" with "real customer
   * tenant" in the data model. Grant sysadmin only via `isSuperAdmin`.
   */
  isSuperAdmin?: boolean;
  /** Organization's quota tier. */
  tier?: QuotaTier;
  /** Resolved feature flags for this user/org */
  features?: string[];
  /**
   * Narrow capability scope for machine/automation tokens (e.g.
   * `'reporting:ingest'`). Absent on normal interactive user tokens. Endpoints
   * that accept a scoped identity check this (see `hasScope`) instead of role;
   * a scoped token is minted with minimal role for least-privilege.
   */
  scope?: TokenScope;
  /** Active organization ID (from UserOrganization membership) */
  organizationId?: string;
  /** Active organization name */
  organizationName?: string;
  /**
   * Org → team hierarchy (org-team-hierarchy proposal, phase 1).
   * `parentOrganizationId` is the active org's direct parent; `rootOrganizationId`
   * is the top of its ancestry chain. Both are **omitted for flat (root) orgs** —
   * consumers should treat the effective root as `rootOrganizationId ?? organizationId`
   * (use the shared {@link effectiveRootOrgId} accessor rather than coalescing inline).
   * Currently every org is flat, so these are absent on all tokens today.
   */
  parentOrganizationId?: string;
  /** Root organization ID of the active org's ancestry chain (see `parentOrganizationId`). */
  rootOrganizationId?: string;
  /**
   * Set on tokens issued by the sysadmin impersonation flow
   * (`POST /admin/impersonate/:userId`). Carries the original sysadmin's
   * user id so audit events still attribute actions correctly.
   */
  impersonatorId?: string;
  /**
   * Unique token id. On an impersonation token it identifies the SESSION, so it
   * can be revoked on its own across every service (see
   * `TokenRevocationStore.getSessionRevocation`). Personal Access Tokens
   * (`token_use: 'api_key'`) carry one too, validated against their own record.
   * A `jti` alone never classifies a token — `token_use` and `impersonatorId` do.
   */
  jti?: string;
  /**
   * When true, the token is read-only — any non-GET request is rejected
   * upstream by the platform's read-only impersonation gate. Lets
   * sysadmins "view as user X" without risking a destructive action.
   */
  impersonationReadOnly?: boolean;
  /**
   * The user's `tokenVersion` at the moment this token was issued. Every
   * privilege change (deactivate / role or tier downgrade / membership or
   * ownership change / password change / logout-all) increments the user's
   * server-side `tokenVersion`, so a token whose embedded version is behind the
   * current one has been REVOKED. Platform validates this against Mongo; the
   * stateless services validate it against a Redis-published current-version
   * store (see `setTokenRevocationStore`). Absent on machine/service tokens.
   */
  tokenVersion?: number;
  /** Token type */
  type: 'access' | 'refresh';
  /** Issued at timestamp */
  iat?: number;
  /** Expiration timestamp */
  exp?: number;
}

/**
 * The account boundary (root org) for a token's active org.
 *
 * The account root is `rootOrganizationId ?? organizationId`: a flat (root) org
 * omits `rootOrganizationId`, so it IS its own root; a team (child) org carries
 * the top of its ancestry chain. Every account-scoped read (quota/seat/billing
 * pooling) must resolve through this coalesce rather than reading
 * `organizationId` directly — the latter silently works today (all orgs flat)
 * but would bind to the team instead of the account once teams exist.
 *
 * @returns the effective root org id, or `undefined` when neither field is set.
 */
export function effectiveRootOrgId(
  payload: Pick<JwtPayload, 'organizationId' | 'rootOrganizationId'>,
): string | undefined {
  return payload.rootOrganizationId ?? payload.organizationId;
}

/**
 * Extended Express Request with user property.
 */
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Service configuration for internal HTTP client.
 */
export interface ServiceConfig {
  /** Service hostname */
  host: string;
  /** Service port */
  port: number;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Health check response.
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  service: string;
  timestamp: string;
  uptime: number;
  version?: string;
  dependencies?: Record<string, 'connected' | 'disconnected' | 'unknown'>;
}
