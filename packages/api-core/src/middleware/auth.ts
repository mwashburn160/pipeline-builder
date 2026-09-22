// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireAuth`: bearer / access-key authentication, the checks every
 * verified request passes, and the tenant identity it attaches.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { tagRouteGate } from './route-table.js';
import { HttpStatus } from '../constants/http-status.js';
import { JwksUnavailableError, UnknownKidError } from '../services/jwks-cache.js';
import { ServiceKeyError, serviceIdentity } from '../services/service-keys.js';
import { type AssuranceLevel } from '../types/common.js';
import { ErrorCode } from '../types/error-codes.js';
import type { HttpRequest } from '../types/http.js';
import { isOpaqueApiKey } from '../utils/api-key.js';
import { getHeaderString } from '../utils/headers.js';
import { getIdentity, type RequestIdentity } from '../utils/identity.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { sendError } from '../utils/response.js';
import { checkRevocation, isImpersonationWriteBlocked, needsRevocationCheck } from './revocation.js';
import { hasValidIdentityClaims, verifyBearerToken } from './jwt-verify.js';
import { isServiceTokenDenied, serviceNameOf } from './service-tokens.js';
import { recordAuthzDenial } from './permission-gates.js';
import { refuseForAssurance } from './assurance.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('auth-middleware');
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
  /**
   * Demand that the whole SESSION be at least this assurance level.
   *
   * `minAssurance: 2` means the person authenticated with a second factor — a
   * passkey with user verification, a password plus an authenticator code, or
   * SSO through an IdP the org marked as enforcing MFA. A weaker token gets
   * **401 `MFA_REQUIRED`**, which the client answers by sending the person to
   * enrolment or to a stronger sign-in; refreshing cannot help, because `aal`
   * lives on the session slot and a refresh never raises it.
   *
   * This is the SESSION-level counterpart to {@link requireStepUp}, which stays
   * a fresh, per-action confirmation. Use both on the most dangerous routes.
   *
   * MACHINES NEVER SATISFY IT. A service principal, an org service account and
   * an exchanged access key all get **403 `HUMAN_SESSION_REQUIRED`** — there is
   * no person behind them to have presented a factor, so "assurance" is not a
   * question their credential can answer. That is deliberately not a silent
   * pass-through for internal services: a route that demands MFA is a route a
   * human is doing something dangerous on.
   */
  minAssurance?: AssuranceLevel;
  /**
   * With {@link minAssurance}, additionally bound how long ago that sign-in
   * happened (seconds, compared against the token's `auth_time`). A session that
   * is MFA-grade but older than this gets **401 `REAUTH_REQUIRED`**. Ignored
   * without `minAssurance` — "how recent" is only meaningful once "how strong"
   * is being asked.
   */
  maxAge?: number;
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
  const gate = tagRouteGate((req: Request, resInner: Response, nextInner: NextFunction) => {
    _requireAuth(options, req, resInner, nextInner);
  }, { kind: 'auth' });
  if (options.minAssurance) {
    tagRouteGate(gate, { kind: 'assurance', minAssurance: options.minAssurance, ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}) });
  }
  return gate;
}
tagRouteGate(requireAuth, { kind: 'auth' });

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

  // An OPAQUE ACCESS KEY (`pb_pat_…` / `pb_sa_…`) carries no claims and no
  // signature, so it cannot be verified here. Trade it at platform for a
  // short-lived JWT (cached in-process until it expires) and then verify that
  // JWT on the normal path — services never read a key hash. See
  // `services/api-key-exchange.ts`.
  if (isOpaqueApiKey(parts[1])) {
    void resolveApiKey(options, parts[1], req, res, next);
    return;
  }

  // `.catch(next)` forwards a DOWNSTREAM synchronous throw from `next()` to
  // Express's error middleware — verification itself never rejects (it maps
  // every failure to a response).
  void verifyAndAttach(options, parts[1], req, res, next).catch(next);
}

/**
 * Exchange an opaque key for a JWT, then continue on the normal verification
 * path. A refused key is a 401; an unreachable platform is a 503 (never a pass —
 * an unverifiable credential is not an identity).
 */
async function resolveApiKey(
  options: RequireAuthOptions,
  key: string,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Loaded LAZILY, on the first key ever presented. A static import would put
  // the HTTP client (and platform's address) into the import graph of every
  // module that merely uses `requireAuth`, which both widens the boot graph and
  // breaks any test that mocks `http-client.js` with a partial module.
  const { exchangeApiKey, ApiKeyExchangeUnavailableError } = await import('../services/api-key-exchange.js');
  let token: string;
  try {
    token = await exchangeApiKey(key);
  } catch (error) {
    if (error instanceof ApiKeyExchangeUnavailableError) {
      return sendError(
        res, HttpStatus.SERVICE_UNAVAILABLE,
        'Access-key verification is temporarily unavailable; please retry',
        ErrorCode.SERVICE_UNAVAILABLE,
      );
    }
    return sendError(res, HttpStatus.UNAUTHORIZED, 'Invalid or revoked access key', ErrorCode.TOKEN_INVALID);
  }
  await verifyAndAttach(options, token, req, res, next);
}

async function verifyAndAttach(
  options: RequireAuthOptions,
  rawToken: string,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Two chains, one entry point (see `verifyBearerToken`): a user token must
    // be ES256 signed by platform and verified against its published JWKS; an
    // internal service token must be ES256 signed by that service's OWN key and
    // declare itself a service principal. Both pin the algorithm (no
    // alg-confusion, no `alg:none`) and both apply the optional issuer/audience
    // binding.
    const decoded = await verifyBearerToken(rawToken);

    if (decoded.type !== 'access') {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Only access tokens can be used for API requests', ErrorCode.TOKEN_INVALID);
    }

    if (!decoded.sub || !decoded.role || !hasValidIdentityClaims(decoded)) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token missing required fields', ErrorCode.TOKEN_INVALID);
    }

    // Service-token kill-switch: reject a service principal whose service has
    // been added to the denylist. Otherwise the only way to invalidate a
    // service's tokens before their (short) TTL is rotating that service's
    // signing key; this cuts one compromised/rogue service off immediately. O(1) Set lookup, zero cost when the denylist
    // is empty (the default), so it never taxes the S2S hot path unless armed.
    if (isServiceTokenDenied(decoded)) {
      emitCounter('service_token_denied_total', { service: serviceNameOf(decoded) ?? 'unknown' });
      logger.warn('Rejected denylisted service token', { sub: decoded.sub });
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Service token revoked', ErrorCode.TOKEN_REVOKED);
    }

    req.user = { ...decoded };

    // READ-ONLY IMPERSONATION. The token names the operator AND says it may only
    // look: every service refuses a state change under it, not only platform —
    // a support session that could write to plugin/compliance/billing is not
    // read-only. Checked before any other gate so no route can forget it.
    if (isImpersonationWriteBlocked(req.method, decoded)) {
      if (req.method) recordAuthzDenial(req, 'impersonation-read-only');
      return sendError(
        res, HttpStatus.FORBIDDEN,
        'Write requests are disabled during read-only impersonation. Stop impersonating to make changes.',
        ErrorCode.IMPERSONATION_READ_ONLY,
      );
    }

    // BOOTSTRAP-ADMIN ENROLMENT SESSION. Such a token exists so
    // the install's only admin can enrol a factor; it is `aal: 1` and must not
    // reach anything else. Platform — which owns the exception and knows which
    // of its own routes `init-platform.sh` calls — allows an explicit few before
    // this point (see its own `requireAuth`); in EVERY other service the answer
    // is simply no, so the reach restriction holds without a per-service
    // allowlist to keep in sync.
    if (decoded.mfaEnrollmentPending === true) {
      emitCounter('mfa_enforcement_refused_total', { service: serviceIdentity(), reason: 'bootstrap_session' });
      recordAuthzDenial(req, 'mfa-enrolment');
      return sendError(
        res, HttpStatus.FORBIDDEN,
        'Finish setting up two-factor authentication before using the rest of Pipeline Builder',
        ErrorCode.MFA_ENROLLMENT_REQUIRED,
      );
    }

    // Session-level assurance (`requireAuth({ minAssurance, maxAge })`).
    if (options.minAssurance
      && refuseForAssurance({ minAssurance: options.minAssurance, ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}) }, decoded, req, res)) return;

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

    // Re-derive the request's tenant identity from the NOW-verified JWT.
    //
    // `attachRequestContext` runs as a global middleware BEFORE this per-route
    // `requireAuth`, so it captured `req.context.identity` while `req.user` was
    // still undefined — at which point `getIdentity` falls back to the raw,
    // client-settable `x-org-id`/`x-user-id` headers. Every downstream tenant-
    // authority consumer (requireOrgId, withTenantContext's RLS scope, checkQuota,
    // withRoute, and the idempotency namespace) reads `req.context.identity`, so
    // that frozen header-derived value — not the JWT — was governing tenancy on
    // any non-nginx path. Recomputing here, at the single post-verification choke
    // point, makes `getIdentity` prefer the verified `req.user` (see identity.ts)
    // so tenancy is JWT-authoritative. The nginx `x-org-id` overwrite stays as
    // defence-in-depth. Guarded on `req.context` so services/paths that never
    // attach a context (or run requireAuth pre-context) are unaffected.
    const reqCtx = (req as Request & { context?: { identity: RequestIdentity } }).context;
    if (reqCtx) {
      reqCtx.identity = getIdentity(req as unknown as HttpRequest);
    }

    // Session invalidation (token-version store + impersonation-session
    // liveness). No store registered ⇒ only impersonation sessions are checked.
    if (needsRevocationCheck(decoded)) {
      // `.catch(next)` forwards a DOWNSTREAM synchronous throw from `next()` to
      // Express's error middleware — this `next()` runs in a microtask, outside
      // the surrounding try/catch. The check itself never rejects.
      checkRevocation(decoded).then((refusal) => {
        if (refusal) return sendError(res, HttpStatus.UNAUTHORIZED, refusal, ErrorCode.TOKEN_REVOKED);
        next();
      }).catch(next);
      return;
    }

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token has expired', ErrorCode.TOKEN_EXPIRED);
    }

    // The signing keys couldn't be fetched, so the token's validity is UNKNOWN.
    // Fail CLOSED with a retryable 503 — never a pass, and never a 401 that
    // would send a legitimate client off to re-authenticate over our outage.
    // Same reasoning for the SERVICE chain: no readable key bundle means no way
    // to tell a peer's token from a forgery, so the request is refused with a
    // retryable 503 rather than admitted or bounced to re-authenticate.
    if (error instanceof JwksUnavailableError || error instanceof ServiceKeyError) {
      logger.warn('Rejecting request: token signing keys unavailable', { error: error.message });
      return sendError(
        res, HttpStatus.SERVICE_UNAVAILABLE,
        'Token verification is temporarily unavailable; please retry',
        ErrorCode.SERVICE_UNAVAILABLE,
      );
    }

    if (error instanceof UnknownKidError || error instanceof jwt.JsonWebTokenError) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Invalid token', ErrorCode.TOKEN_INVALID);
    }

    return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication failed', ErrorCode.UNAUTHORIZED);
  }
}

