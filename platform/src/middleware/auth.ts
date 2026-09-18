// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, ErrorCode, hasValidIdentityClaims, isOpaqueApiKey, isServiceTokenDenied, isSystemAdmin, resolveUserPermissions, sendError, tagRouteGate } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';
import { toOrgId } from '../helpers/org-id.js';
import { CLIENT_TYPE_HEADER, clientType, readRefreshCookie } from '../helpers/session-cookie.js';
import type { RefreshSession } from '../models/index.js';
import { User, Organization, UserOrganization, ImpersonationRequest } from '../models/index.js';
import type { OrgMemberRole } from '../models/user-organization.js';
import { incCounter } from '../observability/metrics.js';
import { MACHINE_SESSION_NOT_REFRESHABLE } from '../services/auth-errors.js';
import type { AccessTokenPayload } from '../types/index.js';
import { verifyAccessToken, verifyRefreshToken } from '../utils/index.js';

const logger = createLogger('auth-middleware');

/** Minimal user shape needed by populateRequestUser (works with lean objects and documents). */
interface UserLike {
  _id: { toString(): string };
  username: string;
  email: string;
  isEmailVerified: boolean;
  isSuperAdmin?: boolean;
  lastActiveOrgId?: string;
  tokenVersion: number;
}

/**
 * Populate the request.user object with user details from the database.
 * Queries UserOrganization for the active org membership to resolve role and org name.
 *
 * Used by the REFRESH path (`isValidRefreshToken`), whose refresh token carries
 * only `sub`/`tokenVersion` — no role/org/permission claims — so those must be
 * re-derived from the DB. `requireAuth` no longer calls this: an access token
 * already carries fresh claims (kept current by tokenVersion bumps), so it trusts
 * them instead of re-querying on every request.
 *
 * @param req - Express request object to populate
 * @param user - User document from database
 * @param activeOrgId - Optional org ID override (e.g. from JWT)
 * @internal
 */
async function populateRequestUser(req: Request, user: UserLike, slot: RefreshSession, activeOrgId?: string): Promise<void> {
  const userId = user._id.toString();
  const orgId = activeOrgId || user.lastActiveOrgId;

  let role: OrgMemberRole = 'member';
  let organizationId: string | undefined;
  let organizationName: string | undefined;

  if (orgId) {
    const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId), isActive: true }).lean();
    if (membership) {
      role = membership.role as OrgMemberRole;
      organizationId = orgId;
      const org = await Organization.findById(toOrgId(orgId)).select('name').lean();
      organizationName = org?.name;
    }
  }

  // Fall back to first membership if no active org found
  if (!organizationId) {
    const first = await UserOrganization.findOne({ userId, isActive: true }).sort({ joinedAt: 1 }).lean();
    if (first) {
      // The token claimed an org the user is no longer an active member of, so
      // we're running this request under a DIFFERENT org. Legitimate for multi-
      // org users (they keep access to their other orgs), but surface it — a
      // silent re-scope is otherwise invisible when a membership is revoked.
      if (orgId && first.organizationId.toString() !== orgId) {
        logger.warn('Token active-org membership missing; substituting first membership', {
          userId, claimedOrgId: orgId, substitutedOrgId: first.organizationId.toString(),
        });
      }
      role = first.role as OrgMemberRole;
      organizationId = first.organizationId.toString();
      const org = await Organization.findById(toOrgId(organizationId)).select('name').lean();
      organizationName = org?.name;
    }
  }

  // Effective permissions (single-source): superadmins implicitly hold all;
  // otherwise the union of the user's assigned Roles' permissions. The refresh
  // handler re-issues tokens via `issueTokens`, which re-resolves that full set
  // from the user's Roles at issue time — so this middleware needn't flatten Role
  // permissions again here (it passes none and lets the reissue carry them).
  const permissions = resolveUserPermissions([], user.isSuperAdmin === true);

  const payload: AccessTokenPayload = {
    type: 'access',
    sub: userId,
    // The refresh path acts for the PERSON who opened the slot, with exactly the
    // assurance that sign-in earned — read from the slot, never re-derived.
    principalType: 'user',
    token_use: 'access',
    amr: slot.amr,
    aal: slot.aal,
    auth_time: Math.floor(new Date(slot.authTime).getTime() / 1000),
    username: user.username,
    email: user.email,
    role,
    isAdmin: role === 'admin' || role === 'owner',
    permissions,
    // Propagate the sysadmin claim. Missing this here silently turned every
    // sysadmin into a regular user as soon as this middleware ran — every
    // /admin/* and audit route 403'd because `req.user.isSuperAdmin` was
    // undefined. The User document MUST be loaded with `+isSuperAdmin` for
    // this to resolve to true (see the .select() call in requireAuth below).
    isSuperAdmin: user.isSuperAdmin === true,
    isEmailVerified: user.isEmailVerified,
    organizationId,
    organizationName,
    tokenVersion: user.tokenVersion,
  };
  req.user = payload;
}

/**
 * Service-token kill-switch (api-core `SERVICE_TOKEN_DENYLIST`): answer 401 for a
 * denylisted `service:<name>` principal, exactly as api-core's `requireAuth`
 * does. Returns true when the response was sent.
 */
function rejectDeniedService(claims: AccessTokenPayload, res: Response): boolean {
  if (!isServiceTokenDenied(claims)) return false;
  logger.warn('Rejected denylisted service token', { sub: claims.sub });
  sendError(res, 401, 'Service token revoked', ErrorCode.TOKEN_REVOKED);
  return true;
}

/**
 * Middleware to authenticate requests using JWT access tokens.
 * Validates the Bearer token from the Authorization header and populates req.user.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 * @returns 401 if token is missing, invalid, or session is invalidated
 *
 * @example
 * router.get('/protected', requireAuth, handler);
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  // Distinguish missing header (no Authorization at all) from malformed
  // (present but not a Bearer token). The client UI distinguishes "log in"
  // (TOKEN_MISSING) from "session is broken" (TOKEN_INVALID).
  if (!authHeader) {
    return sendError(res, 401, 'Authorization header required', ErrorCode.TOKEN_MISSING);
  }
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Malformed authorization header', ErrorCode.TOKEN_INVALID);
  }

  const token = authHeader.split(' ')[1];

  // An OPAQUE ACCESS KEY (`pb_pat_…` or a service account's `pb_sa_…`)
  // presented straight to platform — the CLI and the deploy scripts export one
  // as PLATFORM_TOKEN. Platform OWNS the key collection, so it resolves the key
  // in place (the same checks and the same claims the exchange endpoint applies)
  // rather than calling its own HTTP endpoint. Every other service exchanges
  // first and only ever sees the resulting JWT.
  if (isOpaqueApiKey(token)) {
    // Loaded LAZILY, on the first key ever presented: the key service reaches
    // the token signer and the whole model graph, none of which the (far more
    // common) JWT path needs in its import graph.
    const { apiKeyService } = await import('../services/api-key-service.js');
    // `req.ip` is Express's `trust proxy`-aware client address — the value a
    // service-account key's IP allowlist is checked against.
    const resolved = await apiKeyService.exchange(token, req.ip);
    if (!resolved.ok) {
      logger.warn('Rejected access key', { reason: resolved.reason });
      incCounter('platform_api_key_auth_failed_total', { reason: resolved.reason });
      return sendError(res, 401, 'Invalid or revoked access key', ErrorCode.TOKEN_INVALID);
    }
    incCounter('platform_api_key_auth_total', { result: 'success' });
    // Decode the token just minted, so `req.user` is byte-for-byte the payload
    // every other service sees for this key — one claim shape, one source.
    req.user = verifyAccessToken(resolved.accessToken);
    return next();
  }

  try {
    const decoded = verifyAccessToken(token);

    // Only access tokens may authenticate Bearer requests. Refresh, step-up,
    // and impersonation tokens are minted via the same JWT secret but carry
    // a non-'access' `type` claim; accepting them here would let those
    // short-lived/special-purpose tokens act as a session bearer.
    if (decoded.type !== 'access') {
      return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
    }

    // Every token must carry a well-formed identity (`principalType`,
    // `token_use`, and a user principal's assurance claims). Fail closed: gates
    // below branch on those claims, so a token without them is not an identity
    // this service can reason about.
    if (!hasValidIdentityClaims(decoded)) {
      return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
    }

    // Service principal (api-core `signServiceToken`, `principalType: 'service'`).
    // These are NOT backed by a User row — `User.findById('service:x')` below
    // would throw a CastError (non-ObjectId) and reject every inter-service call,
    // which silently broke all service→platform hierarchy/name lookups. A service
    // token is a short-lived access token signed with the CALLING service's own
    // key (#14), whose per-route authority is gated by `isServicePrincipal` (and,
    // on the internal routes, by `requireInternalService`); accept it here and skip the
    // user/tokenVersion checks (there is no user/session to invalidate).
    if (decoded.principalType === 'service') {
      if (rejectDeniedService(decoded, res)) return;
      req.user = decoded;
      return next();
    }

    // ORG SERVICE ACCOUNT (#2) — also NOT backed by a User row, so the
    // `User.findById(decoded.sub)` below would reject every one of its requests.
    // Its authority was re-derived from the account, its Roles and its org at
    // EXCHANGE time (5 minutes ago at most) and it has no session or
    // `tokenVersion` to compare, so the verified claims are the identity. It is
    // still subject to every permission gate a member is — and can never pass
    // step-up (api-core's `requireStepUp` refuses the principal outright).
    // Fail closed on a malformed one: the token must name the key it came from.
    if (decoded.principalType === 'service_account') {
      if (decoded.token_use !== 'api_key' || !decoded.jti || !decoded.organizationId) {
        return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
      }
      req.user = decoded;
      return next();
    }

    // The ONLY DB read this path needs: the current tokenVersion, to reject
    // tokens minted before the last "invalidate all sessions" / role / permission
    // / membership change (every such change bumps tokenVersion). Everything else
    // the request needs — role, org, permissions, isSuperAdmin — already rides in
    // the validated JWT and is kept fresh by that same bump, so re-deriving it
    // per request (previously up to 5 sequential queries) is redundant.
    const user = await User.findById(decoded.sub).select('+tokenVersion +isSuperAdmin').lean();

    if (!user) {
      return sendError(res, 401, 'Session invalid');
    }

    if (decoded.impersonatorId) {
      if (!decoded.jti) return sendError(res, 401, 'Session invalid');
      // IMPERSONATION SESSION — named by the `impersonatorId` claim. It carries
      // a `jti` like a PAT does, but its authority lives in a completely
      // different record, so it is classified by the claim, never by the shape.
      //
      // FAIL CLOSED, deliberately against the grain of the rest of auth. The
      // Redis revocation store is fail-open because denying on a blip would lock
      // every user out; here the only cost of failing closed is that an operator
      // re-requests a session, while failing open would mean a session someone
      // explicitly ended keeps working. Consent that cannot be withdrawn is not
      // consent, so an unreadable record denies.
      let session;
      try {
        session = await ImpersonationRequest.findOne({ jti: decoded.jti })
          .select('status expiresAt targetUserId').lean();
      } catch (err) {
        logger.warn('Impersonation session lookup failed — denying', { error: String(err) });
        return sendError(res, 401, 'Session invalid');
      }
      if (!session || session.status !== 'consumed') {
        // `revoked` lands here too: the session was ended early.
        return sendError(res, 401, 'Impersonation session ended');
      }
      // Defense in depth against a jti/sub mismatch — the token must name the
      // user the request was opened against.
      if (String(session.targetUserId) !== String(decoded.sub)) {
        return sendError(res, 401, 'Session invalid');
      }
    } else if (decoded.token_use === 'api_key') {
      // An EXCHANGED ACCESS-KEY token. It lives ~5 minutes and its claims were
      // re-derived from the user, the membership and the org at exchange time,
      // so there is nothing left to re-validate here: no key-record read, no
      // authority re-check, and no `tokenVersion` comparison (a key is revoked by
      // revoking the KEY, which stops the next exchange and therefore the
      // credential everywhere within one token lifetime). `jti` names the key.
      if (!decoded.jti) return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
    } else if (decoded.tokenVersion !== user.tokenVersion) {
      // Session token: reject if minted before the last "invalidate all sessions"
      // / role / permission / membership change.
      return sendError(res, 401, 'Session invalid');
    }

    // Trust the JWT claims verbatim (role/organizationId/organizationName/
    // isSuperAdmin/permissions/tier/features/hierarchy/scope). They were minted
    // for the org the token was issued against and are only stale if tokenVersion
    // moved — which we just checked.
    req.user = decoded;
    next();
  } catch {
    // Token verification failed - return unauthorized without exposing error details
    return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
  }
}

/**
 * Internal service-to-service auth.
 *
 * Verifies a service JWT minted by `signServiceToken` (api-core) — the same
 * mechanism `getServiceAuthHeader` uses for cross-service calls. Accepts
 * tokens carrying `principalType: 'service'` and rejects everything else,
 * so user tokens can't hit internal endpoints by accident.
 *
 * Used by the audit-events ingest endpoint so the plugin build worker
 * (and any future internal emitter) can write into MongoDB without
 * needing a real platform user identity. The signature is verified against the
 * CALLING service's published key (#14) — the same per-service bundle api-core
 * uses, so the two cannot drift.
 *
 * On its own this only proves "some service"; the routes that use it compose
 * `requireInternalService({ callers })` after it to name WHICH.
 */
export async function requireServiceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return sendError(res, 401, 'Authorization header required', ErrorCode.TOKEN_MISSING);
  }
  if (!authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Malformed authorization header', ErrorCode.TOKEN_INVALID);
  }
  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);
    // Same gate as `requireAuth`: only `type: 'access'` may bear requests.
    // Service tokens are minted with `type: 'access'` too — see `signServiceToken`.
    if (decoded.type !== 'access') {
      return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
    }
    if (decoded.principalType !== 'service' || !hasValidIdentityClaims(decoded)) {
      return sendError(res, 403, 'Service auth required');
    }
    if (rejectDeniedService(decoded, res)) return;
    // Hydrate req.user enough that downstream handlers can read sub /
    // organizationId without re-decoding the token.
    req.user = decoded;
    next();
  } catch {
    return sendError(res, 401, 'Token invalid', ErrorCode.TOKEN_INVALID);
  }
}

/**
 * CSRF guard for the cookie-bearing auth endpoints (`/auth/refresh`,
 * `/auth/logout`).
 *
 * The browser's refresh token is a cookie, i.e. ambient authority: it rides
 * along on any same-site request, including one a foreign page provokes. The
 * `X-Pb-Client` header is the defence — a cross-site form, image or navigation
 * cannot set a custom header at all, and a cross-origin `fetch` that tries
 * forces a preflight this service's CORS policy refuses.
 *
 * Required of EVERY caller, not just the browser: making it conditional on
 * "did a cookie arrive" would let an attacker strip the condition. Non-browser
 * callers send `X-Pb-Client: cli` (see docs/authentication.md); the header's
 * VALUE only selects the token transport, its presence is what authorizes.
 */
export function requireClientType(req: Request, res: Response, next: NextFunction): void {
  if (!clientType(req)) {
    incCounter('platform_auth_client_header_missing_total', { path: req.path });
    return sendError(res, 403, `The ${CLIENT_TYPE_HEADER} header is required on this endpoint`, 'CLIENT_TYPE_REQUIRED');
  }
  next();
}

/**
 * Middleware to validate the refresh token a caller presents.
 *
 * TWO transports, one meaning (see helpers/session-cookie.ts): the browser's
 * token arrives in the `pb_refresh` cookie, a CLI/CI caller's in the request
 * body. The cookie WINS when both are present — a browser must not be talked
 * into refreshing a token some injected script supplied. The token that was
 * actually accepted is passed on as `res.locals.presentedRefreshToken`.
 *
 * Checks the signature, that the user's tokenVersion is unchanged, and that the
 * token's refresh-session slot (`sid`) still exists AND is interactive. It does NOT compare the
 * slot's hash: a live slot holding a different hash means this token was already
 * rotated away, and the refresh handler's atomic rotation both detects that and
 * revokes the slot. The slot id is passed on as `res.locals.refreshSessionId`.
 *
 * @param req - Express request object (`pb_refresh` cookie, or refreshToken in body)
 * @param res - Express response object
 * @param next - Express next function
 * @returns 401 if refresh token is missing, invalid, or its session is gone
 *
 * @example
 * router.post('/refresh', requireClientType, isValidRefreshToken, refreshHandler);
 */
export async function isValidRefreshToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const refreshToken = readRefreshCookie(req) ?? req.body?.refreshToken;

  if (!refreshToken || typeof refreshToken !== 'string') {
    return sendError(res, 401, 'Token required');
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded?.sub || decoded.tokenVersion === undefined || !decoded.sid) {
      return sendError(res, 401, 'Token invalid');
    }

    const user = await User.findById(decoded.sub).select('+refreshSessions +tokenVersion +isSuperAdmin');
    const slot = user?.refreshSessions?.find((s) => s.id === decoded.sid);

    if (!user || user.tokenVersion !== decoded.tokenVersion || !slot) {
      return sendError(res, 401, 'Session invalid');
    }

    // MACHINE sessions are not refreshable: a stored credential is renewed only
    // through POST /user/generate-token. Turning it away HERE (before the
    // rotation) is what keeps an operator's CLI — which shares the login that
    // created the credential — from tripping reuse detection and killing it.
    // Deliberately does NOT revoke the slot.
    if (slot.kind === 'machine') {
      logger.warn('Refused refresh for a machine session', { userId: String(user._id), sessionId: slot.id });
      return sendError(res, 401, 'Machine sessions renew through /user/generate-token', MACHINE_SESSION_NOT_REFRESHABLE);
    }

    await populateRequestUser(req, user, slot);
    res.locals.refreshSessionId = decoded.sid;
    res.locals.presentedRefreshToken = refreshToken;
    next();
  } catch {
    // Token verification failed - return unauthorized without exposing error details
    return sendError(res, 401, 'Token invalid');
  }
}

/**
 * Route-level guard for **platform** (system) administrators only — `isSuperAdmin`,
 * not org role. Use this on routes whose controller already calls the
 * `requireSystemAdmin` *helper*, so the route reads accurately (org admins do
 * NOT qualify) and is rejected one layer earlier (defense in depth). Unlike an
 * org-role gate, org admins/owners do NOT qualify here — only platform sysadmins.
 */
export function requireSystemAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user && isSystemAdmin(req)) {
    return next();
  }
  // Unauthenticated → 401 (missing/invalid credentials); authenticated non-sysadmin → 403.
  if (!req.user) return sendError(res, 401, 'Authentication required');
  return sendError(res, 403, 'Forbidden: system administrator access required');
}

// Route-table metadata (see api-core's route-table.ts): these are platform's own
// gates, so tag them here — the coverage test resolves what each route requires
// from the middleware chain, not from source greps.
tagRouteGate(requireAuth, { kind: 'auth' });
tagRouteGate(requireSystemAdmin, { kind: 'systemAdmin' });
tagRouteGate(requireServiceAuth, { kind: 'auth' }, { kind: 'servicePrincipal' });
