// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Permission } from './permissions.js';

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
 * Validate and assert that a value is a valid QuotaType.
 * Throws an error if validation fails.
 *
 * @param value - Value to validate
 * @param fieldName - Name of the field being validated (for error messages)
 * @returns The validated QuotaType
 * @throws Error if value is not a valid QuotaType
 *
 * @example
 * ```typescript
 * try {
 *   const quotaType = validateQuotaType(req.body.quotaType, 'quotaType');
 *   // Use quotaType safely
 * } catch (err) {
 *   return sendError(res, 400, err.message);
 * }
 * ```
 */
export function validateQuotaType(value: unknown, fieldName = 'quotaType'): QuotaType {
  if (!isValidQuotaType(value)) {
    throw new Error(
      `Invalid ${fieldName}: "${value}". Must be one of: ${VALID_QUOTA_TYPES.join(', ')}`,
    );
  }
  return value;
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
   * acting under. This is the canonical signal for sysadmin authority —
   * previously the only path was membership in the well-known "system" org
   * with role admin/owner, which conflated "Pipeline Builder operator" with
   * "real customer tenant" in the data model. Either path still works
   * during the rollout; new users should be granted via `isSuperAdmin`.
   */
  isSuperAdmin?: boolean;
  /** Organization's quota tier ('developer' | 'pro' | 'team' | 'enterprise') */
  tier?: string;
  /** Resolved feature flags for this user/org */
  features?: string[];
  /**
   * Narrow capability scope for machine/automation tokens (e.g.
   * `'reporting:ingest'`). Absent on normal interactive user tokens. Endpoints
   * that accept a scoped identity check this (see `hasScope`) instead of role;
   * a scoped token is minted with minimal role for least-privilege.
   */
  scope?: string;
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
   * When true, the token is read-only — any non-GET request is rejected
   * upstream by the platform's read-only impersonation gate. Lets
   * sysadmins "view as user X" without risking a destructive action.
   */
  impersonationReadOnly?: boolean;
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
