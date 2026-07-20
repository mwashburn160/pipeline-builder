// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { HttpStatus } from '../constants/http-status.js';
import type { JwtPayload } from '../types/common.js';
import { ErrorCode } from '../types/error-codes.js';
import { type Permission, hasPermission } from '../types/permissions.js';
import { getHeaderString } from '../utils/headers.js';
import { createLogger } from '../utils/logger.js';
import { sendError } from '../utils/response.js';

const logger = createLogger('auth-middleware');

/** Cached JWT secret with periodic refresh from env var. */
let _jwtSecret: string | undefined;
let _jwtSecretRefreshedAt = 0;
/** Cached PREVIOUS JWT secret (optional) — enables zero-downtime rotation. */
let _jwtSecretPrevious: string | undefined;
let _jwtSecretPreviousRefreshedAt = 0;
const JWT_SECRET_REFRESH_INTERVAL_MS = 300_000; // 5 minutes

function getJwtSecret(): string {
  const now = Date.now();
  if (!_jwtSecret || now - _jwtSecretRefreshedAt > JWT_SECRET_REFRESH_INTERVAL_MS) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      logger.error('JWT_SECRET environment variable is not set');
      throw new Error('JWT_SECRET environment variable is required');
    }
    if (_jwtSecret && _jwtSecret !== secret) {
      logger.info('JWT secret rotated');
    }
    _jwtSecret = secret;
    _jwtSecretRefreshedAt = now;
  }
  return _jwtSecret;
}

/**
 * The optional PREVIOUS JWT secret (`JWT_SECRET_PREVIOUS`), cached with the same
 * TTL as the primary. Returns `undefined` when unset. During a `JWT_SECRET`
 * rotation, operators set `JWT_SECRET_PREVIOUS` to the old value so tokens signed
 * with EITHER secret keep verifying — closing the auth-outage window where
 * still-valid old-signed (or freshly new-signed) tokens would otherwise be
 * rejected. `undefined` is a valid cached value, so this refreshes purely on the
 * time interval (not on emptiness).
 */
function getJwtSecretPrevious(): string | undefined {
  const now = Date.now();
  if (now - _jwtSecretPreviousRefreshedAt > JWT_SECRET_REFRESH_INTERVAL_MS) {
    _jwtSecretPrevious = process.env.JWT_SECRET_PREVIOUS || undefined;
    _jwtSecretPreviousRefreshedAt = now;
  }
  return _jwtSecretPrevious;
}

/**
 * Verify a JWT against the primary secret, falling back to the previous secret
 * (when `JWT_SECRET_PREVIOUS` is configured) ONLY on a signature/verification
 * failure. This makes token verification survive a secret rotation with zero
 * downtime: a token valid under EITHER secret passes.
 *
 * jsonwebtoken's `verify` takes a single secret, so this is try-primary-then-
 * previous — NOT a secret array. No existing check is weakened:
 *   - `verifyOptions` (algorithm pinning + optional issuer/audience) is applied
 *     identically on BOTH attempts, so alg-confusion / `alg:none` stay blocked.
 *   - Expiry / not-before from the PRIMARY attempt are authoritative and are
 *     re-thrown without a previous-secret retry, so a `TokenExpiredError` is
 *     never masked into an "invalid signature".
 *   - When no previous secret is set, behaviour is byte-for-byte the original:
 *     the primary error propagates unchanged.
 */
function verifyJwtWithRotation(token: string, verifyOptions: jwt.VerifyOptions): JwtPayload {
  try {
    return jwt.verify(token, getJwtSecret(), verifyOptions) as JwtPayload;
  } catch (err) {
    const previous = getJwtSecretPrevious();
    // Fall back to the previous secret only for a signature/verification failure
    // (a plain JsonWebTokenError). Expiry / not-before are enforced regardless of
    // which secret signed the token, so those errors must surface as-is.
    if (
      previous
      && err instanceof jwt.JsonWebTokenError
      && !(err instanceof jwt.TokenExpiredError)
      && !(err instanceof jwt.NotBeforeError)
    ) {
      // A token signed by the previous secret verifies here; if it is instead
      // expired/invalid under the previous secret, that error propagates and is
      // handled by the caller exactly like a primary failure.
      return jwt.verify(token, previous, verifyOptions) as JwtPayload;
    }
    throw err;
  }
}

export interface RequireAuthOptions {
  /**
   * Allow x-org-id/x-org-name headers to override the JWT's organization fields.
   *
   * When enabled, the `x-org-id`/`x-org-name` headers override the caller's org
   * — but ONLY for a verified SYS-ADMIN (`isSuperAdmin` claim). For any ordinary
   * authenticated user the headers are ignored, so enabling this can never let a
   * normal user impersonate another tenant's org. Use for cross-org admin tooling
   * (e.g. a sysadmin managing a given org's billing). If unsure, leave it disabled.
   */
  allowOrgHeaderOverride?: boolean;
}

/** JWT auth middleware. Use directly or call with options. */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void;
export function requireAuth(
  options?: RequireAuthOptions,
): (req: Request, res: Response, next: NextFunction) => void;
export function requireAuth(
  reqOrOptions?: Request | RequireAuthOptions,
  res?: Response,
  next?: NextFunction,
): void | ((req: Request, res: Response, next: NextFunction) => void) {
  if (reqOrOptions && res && next && 'headers' in reqOrOptions) {
    return _requireAuth({}, reqOrOptions as Request, res, next);
  }

  const options = (reqOrOptions as RequireAuthOptions) || {};
  return (req: Request, resInner: Response, nextInner: NextFunction) => {
    _requireAuth(options, req, resInner, nextInner);
  };
}

/**
 * A source of the CURRENT `tokenVersion` for a user, backed by a store the
 * stateless services can read (in practice a Redis key the platform publishes
 * to on every privilege change). Registered via {@link setTokenRevocationStore}.
 *
 * `getCurrentVersion` returns the user's current version, or `null` when the
 * store has no entry — a miss is treated as "no known revocation" (fail-open):
 * revocation entries are published with a TTL matching the access-token
 * lifetime, so a missing entry means any token old enough to predate it has
 * already expired on its own.
 */
export interface TokenRevocationStore {
  getCurrentVersion(userId: string): Promise<number | null>;
}

let tokenRevocationStore: TokenRevocationStore | undefined;

/**
 * Register (or clear, with `undefined`) the process-wide token-revocation store.
 * When unset (the default), `requireAuth` performs NO revocation check and
 * behaves exactly as before — so this is fully backward compatible and services
 * opt in at boot by wiring their Redis client. Platform keeps its own Mongo-
 * backed check and need not register one.
 */
export function setTokenRevocationStore(store: TokenRevocationStore | undefined): void {
  tokenRevocationStore = store;
}

/**
 * Returns true when `decoded` has been revoked per the registered store: its
 * embedded `tokenVersion` is strictly behind the store's current version.
 * Fail-open — any store error, a missing entry, or a token/store without a
 * usable version yields `false` (allow). Never throws.
 */
async function isTokenRevoked(decoded: JwtPayload): Promise<boolean> {
  const store = tokenRevocationStore;
  if (!store || !decoded.sub || typeof decoded.tokenVersion !== 'number') return false;
  try {
    const current = await store.getCurrentVersion(decoded.sub);
    return current !== null && decoded.tokenVersion < current;
  } catch {
    // Fail-open: a revocation-store outage must not lock every user out.
    return false;
  }
}

function _requireAuth(
  options: RequireAuthOptions,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authorization header required', ErrorCode.TOKEN_MISSING);
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Invalid authorization format. Use: Bearer <token>', ErrorCode.TOKEN_INVALID);
  }

  try {
    // Pass through optional issuer/audience verification when env-configured.
    // Without these, a JWT signed by any system that happens to share the
    // same JWT_SECRET would be accepted — defence-in-depth for shared-secret
    // misconfigurations across services / environments.
    // Pin the accepted algorithm to the configured HMAC alg (default HS256).
    // Without an allow-list, `jwt.verify` accepts any algorithm the key can
    // verify — the classic alg-confusion vector (and a hard guard against
    // `alg:none`). Env-driven so it stays in lockstep with how tokens are
    // signed (see signServiceToken + platform's config.auth.jwt.algorithm).
    const verifyOptions: jwt.VerifyOptions = { algorithms: [(process.env.JWT_ALGORITHM || 'HS256') as jwt.Algorithm] };
    const expectedIssuer = process.env.JWT_ISSUER;
    const expectedAudience = process.env.JWT_AUDIENCE;
    if (expectedIssuer) verifyOptions.issuer = expectedIssuer;
    if (expectedAudience) verifyOptions.audience = expectedAudience;
    const decoded = verifyJwtWithRotation(parts[1], verifyOptions);

    if (decoded.type !== 'access') {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Only access tokens can be used for API requests', ErrorCode.TOKEN_INVALID);
    }

    if (!decoded.sub || !decoded.role) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token missing required fields', ErrorCode.TOKEN_INVALID);
    }

    req.user = { ...decoded };

    // The x-org-id/x-org-name override lets a SYS-ADMIN act on a chosen org
    // (cross-org admin tooling). It is gated on the verified `isSuperAdmin` claim
    // here so that even a route which mistakenly enables `allowOrgHeaderOverride`
    // can NEVER let an ordinary authenticated user spoof another tenant's org via
    // the header — defence-in-depth against the cross-tenant break this caused.
    if (options.allowOrgHeaderOverride && decoded.isSuperAdmin === true) {
      const headerOrgId = getHeaderString(req.headers['x-org-id']);
      const headerOrgName = getHeaderString(req.headers['x-org-name']);
      if (headerOrgId) req.user.organizationId = headerOrgId;
      if (headerOrgName) req.user.organizationName = headerOrgName;
    }

    // Session-invalidation check for the stateless services: reject a token
    // whose `tokenVersion` is behind the revocation store's current value (a
    // privilege change the platform published). No store registered ⇒ this is a
    // no-op and control passes straight through. Fail-open on any store error.
    if (tokenRevocationStore && decoded.sub && typeof decoded.tokenVersion === 'number') {
      // `.catch(next)` forwards a DOWNSTREAM synchronous throw from `next()` to
      // Express's error middleware — without it, that throw would surface as an
      // unhandled rejection (this `next()` runs in a microtask, outside the
      // surrounding try/catch and Express's per-layer dispatch). `isTokenRevoked`
      // itself never rejects (it fail-opens internally), so the catch only ever
      // sees a genuine downstream error.
      isTokenRevoked(decoded)
        .then((revoked) => {
          if (revoked) {
            return sendError(res, HttpStatus.UNAUTHORIZED, 'Session has been revoked; please sign in again', ErrorCode.TOKEN_REVOKED);
          }
          next();
        })
        .catch(next);
      return;
    }

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token has expired', ErrorCode.TOKEN_EXPIRED);
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Invalid token', ErrorCode.TOKEN_INVALID);
    }

    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication failed', ErrorCode.UNAUTHORIZED);
  }
}

/**
 * Requires admin role. Use after requireAuth.
 * Permits users whose per-org role is 'admin' or 'owner'.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
  }

  if (req.user.role !== 'admin' && req.user.role !== 'owner') {
    return sendError(res, HttpStatus.FORBIDDEN, 'Admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
  }

  next();
}

/**
 * Whether the request's user holds `permission`. Superadmins implicitly hold
 * every permission. Reads the resolved `permissions` claim (set at token issue,
 * or re-derived per request by the platform).
 */
export function userHasPermission(req: Request, permission: Permission): boolean {
  return hasPermission(req.user?.permissions, permission, req.user?.isSuperAdmin);
}

/**
 * Context passed to a registered authorization-denial auditor when a
 * state-changing request is rejected by `requirePermission` /
 * `requireSystemAdmin`.
 */
export interface AuthzDenialInfo {
  /** The denied user's id (`sub`), if authenticated. */
  actorId?: string;
  actorEmail?: string;
  /** The user's active org at denial time. */
  orgId?: string;
  /** HTTP method + path of the rejected request. */
  method: string;
  path: string;
  /** What was required: the missing permission(s), or 'system-admin'. */
  required: string;
}

/**
 * Optional sink for denied-authorization events. Left unset by default so
 * api-core stays decoupled from any audit transport — a service registers one
 * at boot (typically forwarding to its `RemoteAuditClient` as an
 * `authz.denied` event, or, on platform, to the local `audit()` helper).
 * MUST be best-effort: it is invoked inside the request path, so it must never
 * throw or block (the gate wraps the call in try/catch regardless).
 */
let authzDenialAuditor: ((info: AuthzDenialInfo) => void) | undefined;

/**
 * Register (or clear, with `undefined`) the process-wide authorization-denial
 * auditor. Idempotent; the last registration wins.
 */
export function setAuthzDenialAuditor(fn: ((info: AuthzDenialInfo) => void) | undefined): void {
  authzDenialAuditor = fn;
}

/**
 * Emit a denial event, best-effort. Only fires for state-changing (non-GET,
 * non-HEAD/OPTIONS) requests — a rejected GET is low-signal probing noise and
 * would amplify audit volume under a scan. Never throws.
 */
function auditAuthzDenial(req: Request, required: string): void {
  const auditor = authzDenialAuditor;
  if (!auditor) return;
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  try {
    auditor({
      actorId: req.user?.sub,
      actorEmail: req.user?.email,
      orgId: req.user?.organizationId,
      method,
      path: req.originalUrl || req.url,
      required,
    });
  } catch {
    // Best-effort — a broken auditor must never break the auth gate.
  }
}

/**
 * Requires that the user hold AT LEAST ONE of the given permissions (or be a
 * superadmin). Use after requireAuth. Mirrors `requireRole`'s any-of semantics;
 * pass a single permission for a specific action, or several when any one of
 * them should grant access.
 */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }
    // userHasPermission → hasPermission already grants superadmins every
    // permission, so this single check covers both the superadmin bypass and
    // the any-of membership test without re-inlining either.
    if (permissions.some((p) => userHasPermission(req, p))) return next();
    auditAuthzDenial(req, permissions.join(' or '));
    return sendError(
      res, HttpStatus.FORBIDDEN,
      `Missing required permission: ${permissions.join(' or ')}`,
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  };
}

/**
 * Requires that the user hold EVERY one of the given permissions (or be a
 * superadmin) — the AND counterpart to `requirePermission`'s any-of. Use for a
 * sensitive action that legitimately demands two distinct capabilities at once
 * (e.g. a cross-surface operation), so the guarantee is explicit rather than
 * approximated by chaining two `requirePermission` gates. Superadmins bypass
 * (they implicitly hold every permission).
 */
export function requireAllPermissions(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }
    const missing = permissions.filter((p) => !userHasPermission(req, p));
    if (missing.length === 0) return next();
    auditAuthzDenial(req, permissions.join(' and '));
    return sendError(
      res, HttpStatus.FORBIDDEN,
      `Missing required permission: ${missing.join(' and ')}`,
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  };
}

/**
 * The system tenant's canonical org **id** — a fixed, well-known ObjectId (NOT
 * the string 'system'). This is the single knob every service resolves the
 * system tenant through; override via the `SYSTEM_ORG_ID` env for alternate
 * installs. The system org's human identifier stays the slug/name 'system'
 * (see {@link SYSTEM_ORG_SLUG}); only its `_id` is this ObjectId.
 */
export const SYSTEM_ORG_ID = (process.env.SYSTEM_ORG_ID || '000000000000000000000001').toLowerCase();

/** The system org's well-known slug/name (the human identifier; its `_id` is {@link SYSTEM_ORG_ID}). */
export const SYSTEM_ORG_SLUG = 'system';

/**
 * Check if an orgId or orgName/slug matches the system org. Use this instead of
 * comparing directly: the id is now an ObjectId ({@link SYSTEM_ORG_ID}) while the
 * name/slug is 'system' ({@link SYSTEM_ORG_SLUG}), so the two are compared against
 * their respective canonical values.
 */
export function isSystemOrgId(orgId?: string, orgName?: string): boolean {
  return orgId?.toLowerCase() === SYSTEM_ORG_ID || orgName?.toLowerCase() === SYSTEM_ORG_SLUG;
}

/**
 * Check if the request is from a system admin.
 *
 * Authority is granted solely by the user-level `isSuperAdmin` flag carried
 * in the JWT. The "membership in the well-known 'system' org with role
 * admin/owner" path was removed — it conflated a Pipeline Builder operator
 * with a real customer tenant in the data model, and meant any unintended
 * write that created a 'system'-named org could quietly grant cross-org
 * authority. The `system` org still exists as a *content holder* for shared
 * sample data; it just no longer confers privilege.
 */
export function isSystemAdmin(req: Request): boolean {
  return req.user?.isSuperAdmin === true;
}

/**
 * Whether the request's token carries a specific capability `scope` (e.g.
 * `'reporting:ingest'`). Used to gate endpoints that accept a narrow machine
 * identity — a normal interactive user token has no `scope` and returns false.
 */
export function hasScope(req: Request, scope: string): boolean {
  return req.user?.scope === scope;
}

/** Requires system admin (admin role + system organization). */
export function requireSystemAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isSystemAdmin(req)) {
    auditAuthzDenial(req, 'system-admin');
    return sendError(
      res, HttpStatus.FORBIDDEN,
      'Access denied. Only system administrators can perform this action.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }
  next();
}

/**
 * Require a specific feature flag. Use after requireAuth.
 * Checks the `features` array in the JWT payload (set at token issuance).
 * Sysadmins (isSuperAdmin) bypass — they always have every feature.
 */
export function requireFeature(feature: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }

    // Sysadmins get all features; the `features` array on their token is
    // populated with every flag at issuance time but the bypass here keeps
    // the rule explicit and survives a token issued before a new feature
    // flag was added.
    if (req.user.isSuperAdmin === true) return next();

    if (!req.user.features?.includes(feature)) {
      return sendError(
        res, HttpStatus.FORBIDDEN,
        `This feature requires a higher plan (${feature})`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    next();
  };
}

/**
 * Resolve the effective access modifier for an entity being created/updated.
 * 'public' is permitted for any admin or owner role (system admins create
 * catalog-wide public entities; org admins create org-wide public entities).
 * Everyone else (member role, no role) gets 'private'.
 */
export function resolveAccessModifier(req: Request, requested: string | undefined): 'public' | 'private' {
  if (requested === 'public' && (req.user?.role === 'admin' || req.user?.role === 'owner')) {
    return 'public';
  }
  return 'private';
}

// ---------------------------------------------------------------------------
// Service-to-service tokens
//
// Inter-service HTTP calls (billing → message, platform → compliance, etc.)
// need to satisfy the same `requireAuth` middleware as user requests.
// `signServiceToken` mints a short-lived JWT signed with the shared
// JWT_SECRET, identifying the calling service via `sub: 'service:<name>'`.
// `requireAuth` accepts these tokens transparently — they pass `decoded.sub`
// and `decoded.role` checks, and downstream `requireOrganization` /
// `requireAdmin` rely on the org/role embedded in the token.
//
// Tokens default to 5-minute TTL — long enough to survive a backend hop,
// short enough that a leaked token is low-value.
// ---------------------------------------------------------------------------

const DEFAULT_SERVICE_TOKEN_TTL_SECONDS = 300;

export interface ServiceTokenOptions {
  /** Calling service identifier (e.g. 'billing', 'platform'). Embedded as `sub: service:<name>`. */
  serviceName: string;
  /** Active org context for the call. Use the target tenant's org ID, or 'system' for system-wide ops. */
  orgId?: string;
  /** Active org name. Defaults to orgId. */
  orgName?: string;
  /** TTL in seconds (default 300). */
  ttlSeconds?: number;
  /**
   * Role the token carries (required — no implicit default). **Pass the LOWEST
   * role the call actually needs** (`'member'` for read / data-plane calls) so a
   * leaked service token can't perform admin actions in the target org.
   * `isAdmin` is derived from this (admin|owner → true).
   */
  role: 'owner' | 'admin' | 'member';
}

/**
 * Mint a JWT identifying the calling service. Used for inter-service HTTP calls.
 * The token satisfies `requireAuth` and (when orgId is present) `requireOrganization`.
 * Scope it with `opts.role` — least privilege keeps a leaked token low-value.
 */
export function signServiceToken(opts: ServiceTokenOptions): string {
  const role = opts.role;
  const payload: JwtPayload = {
    sub: `service:${opts.serviceName}`,
    username: `${opts.serviceName}-service`,
    email: `${opts.serviceName}@internal`,
    role,
    isAdmin: role === 'owner' || role === 'admin',
    type: 'access',
    organizationId: opts.orgId,
    organizationName: opts.orgName ?? opts.orgId,
  };
  // Match the optional issuer/audience that requireAuth verifies, when
  // configured. Without these, a service token signed here would fail
  // requireAuth in a deployment that has set JWT_ISSUER/JWT_AUDIENCE.
  const signOptions: jwt.SignOptions = {
    expiresIn: opts.ttlSeconds ?? DEFAULT_SERVICE_TOKEN_TTL_SECONDS,
    // Sign with the same configured alg requireAuth pins on verify, so service
    // tokens stay valid under a non-default JWT_ALGORITHM.
    algorithm: (process.env.JWT_ALGORITHM || 'HS256') as jwt.Algorithm,
    // Unique token id on every mint. Combined with the short (300s default) TTL
    // this gives each service token a distinct identity — the building block for
    // replay detection (a verifier can track seen jtis) and the correlation
    // handle for tracing which mint performed a cross-service action. It does
    // NOT by itself prevent replay within the TTL window; true replay defence
    // needs the asymmetric-key work tracked separately.
    jwtid: randomUUID(),
  };
  if (process.env.JWT_ISSUER) signOptions.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) signOptions.audience = process.env.JWT_AUDIENCE;
  return jwt.sign(payload, getJwtSecret(), signOptions);
}

/** Convenience: returns a `Bearer <token>` header value for fetch/axios calls. */
export function getServiceAuthHeader(opts: ServiceTokenOptions): string {
  return `Bearer ${signServiceToken(opts)}`;
}

/** True when `req.user.sub` was issued by `signServiceToken` (i.e. starts with `service:`). */
export function isServicePrincipal(req: Request): boolean {
  return req.user?.sub?.startsWith('service:') ?? false;
}

/**
 * PRE-auth check: cryptographically verify the request carries a valid, signed
 * SERVICE token (`sub` starts with `service:`). Unlike {@link isServicePrincipal}
 * (which reads the already-populated `req.user`), this verifies the bearer token
 * itself, so it is safe to call BEFORE `requireAuth` runs — e.g. the global rate
 * limiter's `skip`, which must not trust the spoofable `x-internal-service`
 * header. Mirrors `requireAuth`'s verification (algorithm pinning + optional
 * issuer/audience) and returns `false` on any missing/invalid/non-service token.
 */
export function verifyServicePrincipal(req: Request): boolean {
  const parts = req.headers.authorization?.split(' ');
  if (!parts || parts.length !== 2 || parts[0] !== 'Bearer') return false;
  try {
    const verifyOptions: jwt.VerifyOptions = { algorithms: [(process.env.JWT_ALGORITHM || 'HS256') as jwt.Algorithm] };
    if (process.env.JWT_ISSUER) verifyOptions.issuer = process.env.JWT_ISSUER;
    if (process.env.JWT_AUDIENCE) verifyOptions.audience = process.env.JWT_AUDIENCE;
    const decoded = verifyJwtWithRotation(parts[1], verifyOptions);
    return decoded.type === 'access' && typeof decoded.sub === 'string' && decoded.sub.startsWith('service:');
  } catch {
    return false;
  }
}
