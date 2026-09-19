// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { tagRouteGate } from './route-table.js';
import { HttpStatus } from '../constants/http-status.js';
import { JwksUnavailableError, UnknownKidError, platformJwksCache } from '../services/jwks-cache.js';
import {
  SERVICE_SUBJECT_PREFIX,
  ServiceKeyError,
  isServiceKid,
  serviceIdentity,
  signServiceJwt,
  verifyServiceJwt,
} from '../services/service-keys.js';
import { AUTH_METHODS, PRINCIPAL_TYPES, TOKEN_USES, type AssuranceLevel, type JwtPayload } from '../types/common.js';
import { ErrorCode } from '../types/error-codes.js';
import type { HttpRequest } from '../types/http.js';
import { type Permission, hasPermission } from '../types/permissions.js';
import { isOpaqueApiKey } from '../utils/api-key.js';
import { getHeaderString } from '../utils/headers.js';
import { getIdentity, type RequestIdentity } from '../utils/identity.js';
import { USER_TOKEN_ALGORITHM, decodeJwtHeader } from '../utils/jwk.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { sendError } from '../utils/response.js';

const logger = createLogger('auth-middleware');

/** Issuer/audience pinning, when the deployment configures them. Shared by both chains. */
function issuerAudienceOptions(): { issuer?: string; audience?: string } {
  return {
    ...(process.env.JWT_ISSUER ? { issuer: process.env.JWT_ISSUER } : {}),
    ...(process.env.JWT_AUDIENCE ? { audience: process.env.JWT_AUDIENCE } : {}),
  };
}

/**
 * Verify a token that speaks for a PERSON — access, step-up, and the token an
 * opaque access key is exchanged for — against platform's published signing
 * keys.
 *
 * ES256 and a `kid` are both mandatory: no `kid` means no way to pick the right
 * key across a rotation, and any other algorithm is refused outright, which is
 * what makes "no service accepts an HS256 user token" a property of the code
 * rather than a convention. Key lookup goes through the shared JWKS cache
 * (10-minute refresh, one refetch on an unknown `kid`, brief negative cache).
 *
 * @throws {UnknownKidError} the key set is current and has no such key → 401.
 * @throws {JwksUnavailableError} the key set could not be obtained → 503; an
 *         unverifiable token is never treated as valid.
 */
export async function verifyUserJwt<T = JwtPayload>(token: string): Promise<T> {
  const header = decodeJwtHeader(token);
  if (header?.alg !== USER_TOKEN_ALGORITHM || !header.kid) {
    throw new jwt.JsonWebTokenError(`User tokens must be signed with ${USER_TOKEN_ALGORITHM} and carry a kid`);
  }
  const key = await platformJwksCache().getKey(header.kid);
  return jwt.verify(token, key, { algorithms: [USER_TOKEN_ALGORITHM], ...issuerAudienceOptions() }) as T;
}

/**
 * Verify ANY bearer token and return its claims.
 *
 * Since #14 there is no shared secret left: BOTH chains are ES256 with a `kid`,
 * so the dispatch is by **who owns the `kid`** rather than by algorithm — and
 * because a `kid` is an RFC 7638 thumbprint, ownership is a fact about the key,
 * not a claim the token makes about itself:
 *
 * - a `kid` published in the per-service key bundle → an INTERNAL SERVICE token
 *   ({@link signServiceToken}), verified with that service's key; its `sub` must
 *   name the same service, so one service can never speak for another.
 * - anything else → a platform-signed USER token, verified against platform's
 *   published JWKS. A token claiming `principalType: 'service'` is refused
 *   here: an internal identity may not ride the user signing key.
 *
 * Anything that is not ES256 with a `kid` fails in both chains, which is what
 * makes "no HS256 token is accepted anywhere" a property of the code.
 */
export async function verifyBearerToken(token: string): Promise<JwtPayload> {
  const header = decodeJwtHeader(token);
  if (!header?.alg) throw new jwt.JsonWebTokenError('Malformed token header');

  if (header.kid && isServiceKid(header.kid)) {
    const claims = verifyServiceJwt<JwtPayload>(token, { kid: header.kid, ...issuerAudienceOptions() });
    if (claims.principalType !== 'service') {
      emitCounter('service_key_non_service_token_rejected_total', { alg: header.alg });
      throw new jwt.JsonWebTokenError('A service signing key may only mint a service principal');
    }
    return claims;
  }

  const claims = await verifyUserJwt(token);
  if (claims.principalType === 'service') {
    throw new jwt.JsonWebTokenError('Service principals may not be signed with the user signing key');
  }
  return claims;
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
  /**
   * Demand that the whole SESSION be at least this assurance level (#8).
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
  /**
   * Whether one IMPERSONATION session (by token `jti`) has been ended early.
   *
   * Optional so a store that predates it still links — but a store WITHOUT it
   * cannot answer, and an impersonation token is then REJECTED. Unlike
   * `getCurrentVersion`, this is deliberately not fail-open: the platform ends a
   * session when someone withdraws consent, and a withdrawn consent that keeps
   * working in every other service is not withdrawn.
   */
  getSessionRevocation?(jti: string): Promise<SessionRevocationState>;
}

/**
 * `revoked`     — the session was ended; reject.
 * `live`        — no revocation recorded; allow.
 * `unavailable` — the store couldn't be read or can't answer; REJECT. Distinct
 *                 from `live` precisely so an outage can't read as "not revoked".
 */
export type SessionRevocationState = 'revoked' | 'live' | 'unavailable';

let tokenRevocationStore: TokenRevocationStore | undefined;

/**
 * Register (or clear, with `undefined`) the process-wide token-revocation store.
 * When unset (the default), `requireAuth` performs NO revocation check (it relies
 * on the short access-token TTL); services opt in at boot by wiring their Redis
 * client. Platform keeps its own Mongo-backed check and need not register one.
 */
export function setTokenRevocationStore(store: TokenRevocationStore | undefined): void {
  tokenRevocationStore = store;
  if (store) revocationStoreMissingWarned = false; // re-arm if a store is (re)registered
}

/** One-shot guard so the "revocation inactive" warning doesn't flood the logs. */
let revocationStoreMissingWarned = false;

/**
 * Returns true when `decoded` has been revoked per the registered store: its
 * embedded `tokenVersion` is strictly behind the store's current version.
 * Fail-open — any store error, a missing entry, or a token/store without a
 * usable version yields `false` (allow). Never throws.
 */
async function isTokenRevoked(decoded: JwtPayload): Promise<boolean> {
  const store = tokenRevocationStore;
  if (!store) {
    // Make the "revocation is OFF" state OBSERVABLE: a service that verifies user
    // tokens but forgot `setTokenRevocationStore()` silently disables the session
    // kill-switch. Warn ONCE (only for a revocable user token) so a misconfigured
    // boot surfaces in the logs instead of failing open invisibly.
    if (!revocationStoreMissingWarned && decoded.sub && typeof decoded.tokenVersion === 'number') {
      revocationStoreMissingWarned = true;
      logger.warn('Token revocation store NOT registered — revocation checks are INACTIVE (setTokenRevocationStore was never called); revoked/compromised sessions stay valid until natural TTL');
    }
    return false;
  }
  if (!decoded.sub || typeof decoded.tokenVersion !== 'number') return false;
  try {
    const current = await store.getCurrentVersion(decoded.sub);
    return current !== null && decoded.tokenVersion < current;
  } catch {
    // Fail-open: a revocation-store outage must not lock every user out.
    return false;
  }
}

/**
 * Resolve an impersonation session's revocation state. Never throws: any failure
 * — no store, a store that can't answer, a read error — is `unavailable`, which
 * callers treat as revoked.
 */
async function sessionRevocationState(jti: string): Promise<SessionRevocationState> {
  const store = tokenRevocationStore;
  if (!store?.getSessionRevocation) return 'unavailable';
  try {
    return await store.getSessionRevocation(jti);
  } catch {
    return 'unavailable';
  }
}

/** An impersonation session token: it names the operator AND carries its own session id. */
function isImpersonationSession(decoded: { impersonatorId?: unknown; jti?: unknown }): decoded is { impersonatorId: string; jti: string } {
  return typeof decoded.impersonatorId === 'string' && typeof decoded.jti === 'string' && decoded.jti.length > 0;
}

/**
 * Public revocation check for routes that verify a platform JWT OUTSIDE
 * `requireAuth` (e.g. the image-registry `/token` mint path, which resolves
 * identity itself). Returns true when the token's `tokenVersion` is strictly
 * behind the store's current version. Fail-open (never throws) — a store outage
 * or a token/store without a usable version yields false (allow), matching
 * `requireAuth`. Pass the verified JWT claims (`sub`, `tokenVersion`).
 */
export async function isAccessTokenRevoked(
  claims: { sub?: string; tokenVersion?: number; jti?: string; impersonatorId?: string },
): Promise<boolean> {
  // An impersonation session is revoked unless the store positively says live —
  // including on this out-of-band path, or a revoked session could still mint
  // registry tokens.
  if (isImpersonationSession(claims) && await sessionRevocationState(claims.jti) !== 'live') return true;
  return isTokenRevoked(claims as JwtPayload);
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
    // internal service token stays on the shared secret and must declare itself
    // a service principal. Both pin the algorithm (no alg-confusion, no
    // `alg:none`) and both apply the optional issuer/audience binding.
    const decoded = await verifyBearerToken(rawToken);

    if (decoded.type !== 'access') {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Only access tokens can be used for API requests', ErrorCode.TOKEN_INVALID);
    }

    if (!decoded.sub || !decoded.role || !hasValidIdentityClaims(decoded)) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Token missing required fields', ErrorCode.TOKEN_INVALID);
    }

    // Service-token kill-switch: reject a service principal whose service has
    // been added to the denylist. Rotating the shared JWT secret is the only
    // other way to invalidate a service token before its (short) TTL — but that
    // nukes EVERY service token fleet-wide. This lets one compromised/rogue
    // service be cut off surgically. O(1) Set lookup, zero cost when the denylist
    // is empty (the default), so it never taxes the S2S hot path unless armed.
    if (isServiceTokenDenied(decoded)) {
      emitCounter('service_token_denied_total', { service: serviceNameOf(decoded) ?? 'unknown' });
      logger.warn('Rejected denylisted service token', { sub: decoded.sub });
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Service token revoked', ErrorCode.TOKEN_REVOKED);
    }

    req.user = { ...decoded };

    // BOOTSTRAP-ADMIN ENROLMENT SESSION (#8, revision 4). Such a token exists so
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

    // Session-invalidation check for the stateless services: reject a token
    // whose `tokenVersion` is behind the revocation store's current value (a
    // privilege change the platform published). No store registered ⇒ this is a
    // no-op and control passes straight through. Fail-open on any store error.
    // An impersonation session is checked even when NO store is registered: the
    // tokenVersion check below is a no-op without a store, but for a session
    // that would silently mean "never revoked". Here no store ⇒ unavailable ⇒
    // rejected. See `TokenRevocationStore.getSessionRevocation`.
    const impersonation = isImpersonationSession(decoded);
    if (impersonation || (tokenRevocationStore && decoded.sub && typeof decoded.tokenVersion === 'number')) {
      // `.catch(next)` forwards a DOWNSTREAM synchronous throw from `next()` to
      // Express's error middleware — without it, that throw would surface as an
      // unhandled rejection (this `next()` runs in a microtask, outside the
      // surrounding try/catch and Express's per-layer dispatch). The checks
      // themselves never reject, so the catch only ever sees a downstream error.
      (async () => {
        if (impersonation) {
          const state = await sessionRevocationState(decoded.jti as string);
          if (state !== 'live') {
            return sendError(
              res,
              HttpStatus.UNAUTHORIZED,
              state === 'revoked'
                ? 'This impersonation session has been ended'
                : 'This impersonation session could not be verified',
              ErrorCode.TOKEN_REVOKED,
            );
          }
        }
        if (tokenRevocationStore && decoded.sub && typeof decoded.tokenVersion === 'number' && await isTokenRevoked(decoded)) {
          return sendError(res, HttpStatus.UNAUTHORIZED, 'Session has been revoked; please sign in again', ErrorCode.TOKEN_REVOKED);
        }
        next();
      })().catch(next);
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

/**
 * Whether a set of verified claims speaks for a PERSON's own session — the only
 * kind of credential an assurance level can be asserted about.
 *
 * Excludes all three machine shapes: an internal service principal, an org
 * service account, and any exchanged access key (`token_use: 'api_key'`, i.e. a
 * PAT or a service-account key), each of which authenticates a program holding a
 * secret rather than a person presenting factors.
 */
export function isHumanPrincipal(claims: Pick<JwtPayload, 'principalType' | 'token_use'> | undefined): boolean {
  return claims?.principalType === 'user' && claims.token_use === 'access';
}

/** What an assurance gate demands. */
export interface AssuranceOptions {
  minAssurance: AssuranceLevel;
  maxAge?: number;
}

/**
 * Standalone assurance gate, for a service whose own `requireAuth` is not
 * api-core's (platform's is its own, because it reads Mongo). Compose it AFTER
 * authentication: `router.get('/x', requireAuth, requireAssurance({ minAssurance: 2 }), h)`.
 *
 * Identical rules and identical refusals to `requireAuth({ minAssurance })` —
 * that option simply calls the same check inline, so there is one implementation
 * of "is this session MFA-grade" in the codebase.
 */
export function requireAssurance(options: AssuranceOptions) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }
    if (refuseForAssurance(options, req.user as JwtPayload, req, res)) return;
    next();
  }, { kind: 'assurance', minAssurance: options.minAssurance, ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}) });
}

/**
 * Enforce `minAssurance` / `maxAge` on a verified token. Returns true when the
 * request was REFUSED (a response has been sent).
 *
 * Three distinct refusals, because the client's next move differs for each:
 * a machine must stop (403), a weak session must gain a factor (401
 * `MFA_REQUIRED` → enrolment, never a sign-out), and a stale one must simply
 * authenticate again (401 `REAUTH_REQUIRED`).
 */
function refuseForAssurance(
  options: AssuranceOptions,
  decoded: JwtPayload,
  req: Request,
  res: Response,
): boolean {
  const minAssurance = options.minAssurance;
  const refuse = (reason: string, status: number, message: string, code: ErrorCode): true => {
    emitCounter('mfa_enforcement_refused_total', { service: serviceIdentity(), reason });
    recordAuthzDenial(req, `assurance:${minAssurance}`);
    sendError(res, status, message, code);
    return true;
  };

  if (!isHumanPrincipal(decoded)) {
    return refuse(
      'machine_principal', HttpStatus.FORBIDDEN,
      'This action requires a person signed in with two-factor authentication — API keys and service accounts cannot perform it',
      ErrorCode.HUMAN_SESSION_REQUIRED,
    );
  }
  if ((decoded.aal ?? 1) < minAssurance) {
    return refuse(
      'weak_session', HttpStatus.UNAUTHORIZED,
      'This action requires two-factor authentication — sign in again with a passkey or an authenticator code',
      ErrorCode.MFA_REQUIRED,
    );
  }
  if (options.maxAge !== undefined) {
    const authTime = decoded.auth_time;
    // No `auth_time` is not "recent enough by default" — `hasValidIdentityClaims`
    // already requires it on a user token, so an absent one means a token this
    // gate cannot reason about. Fail closed.
    if (typeof authTime !== 'number' || Math.floor(Date.now() / 1000) - authTime > options.maxAge) {
      return refuse(
        'stale_session', HttpStatus.UNAUTHORIZED,
        'This action requires a recent sign-in — please authenticate again',
        ErrorCode.REAUTH_REQUIRED,
      );
    }
  }
  return false;
}

/**
 * Whether a verified token carries a well-formed identity: a known
 * `principalType` and `token_use`, and the claims that kind of principal must
 * have. Fails closed — a token minted before these claims existed, or one with a
 * contradictory combination, is not an identity any gate should reason about.
 *
 * - `service`: `token_use: 'access'` and a `service:<name>` subject (the name
 *   feeds the denylist and audit attribution).
 * - `user` / `service_account`: `amr` (known methods), `aal` and `auth_time`.
 */
export function hasValidIdentityClaims(decoded: Partial<JwtPayload>): boolean {
  if (!decoded.principalType || !PRINCIPAL_TYPES.includes(decoded.principalType)) return false;
  if (!decoded.token_use || !TOKEN_USES.includes(decoded.token_use)) return false;
  if (decoded.principalType === 'service') {
    return decoded.token_use === 'access'
      && typeof decoded.sub === 'string'
      && decoded.sub.startsWith(SERVICE_SUBJECT_PREFIX)
      && decoded.sub.length > SERVICE_SUBJECT_PREFIX.length;
  }
  return Array.isArray(decoded.amr)
    && decoded.amr.every((m) => AUTH_METHODS.includes(m))
    && (decoded.aal === 1 || decoded.aal === 2)
    && typeof decoded.auth_time === 'number';
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
 *
 * The permission gates here call it themselves. Export it for data-driven checks
 * a route makes inline (cross-org access, service-only endpoints), so those 403s
 * reach the same `authz.denied` trail. `required` names what was missing.
 */
export function recordAuthzDenial(req: Request, required: string): void {
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
      // Strip the query string — a denied request may carry a token/secret as a
      // query param, and this path is persisted verbatim into the audit log.
      path: (req.originalUrl || req.url).split('?')[0],
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
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }
    // userHasPermission → hasPermission already grants superadmins every
    // permission, so this single check covers both the superadmin bypass and
    // the any-of membership test without re-inlining either.
    if (permissions.some((p) => userHasPermission(req, p))) return next();
    recordAuthzDenial(req, permissions.join(' or '));
    return sendError(
      res, HttpStatus.FORBIDDEN,
      `Missing required permission: ${permissions.join(' or ')}`,
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }, { kind: 'permission', mode: 'any', permissions });
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
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }
    const missing = permissions.filter((p) => !userHasPermission(req, p));
    if (missing.length === 0) return next();
    recordAuthzDenial(req, permissions.join(' and '));
    return sendError(
      res, HttpStatus.FORBIDDEN,
      `Missing required permission: ${missing.join(' and ')}`,
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }, { kind: 'permission', mode: 'all', permissions });
}

/**
 * Like {@link requirePermission} (any-of) but ALSO admits an internal service
 * principal (`principalType: 'service'`). For READ endpoints that BOTH
 * interactive users — who must hold one of the `:read` capabilities — AND
 * service-to-service callers legitimately hit; service tokens carry no
 * permission claims (they're least-privilege `role:member`), so a plain
 * `requirePermission` would wrongly 403 them. Superadmins pass via
 * `userHasPermission`'s implicit-all. Use only where a service caller is a known,
 * intended consumer of the route (verify the callers); prefer plain
 * `requirePermission` for purely user-facing reads.
 */
export function requirePermissionOrService(...permissions: Permission[]) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }
    if (isServicePrincipal(req) || permissions.some((p) => userHasPermission(req, p))) return next();
    recordAuthzDenial(req, permissions.join(' or '));
    return sendError(
      res, HttpStatus.FORBIDDEN,
      `Missing required permission: ${permissions.join(' or ')}`,
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }, { kind: 'permission', mode: 'any', permissions, allowService: true });
}

/**
 * Gate an endpoint to internal service-to-service callers only (a
 * `principalType: 'service'` principal minted via {@link signServiceToken} / `getServiceAuthHeader`).
 * Rejects any user token. For NON-user-facing endpoints — entity-event ingest,
 * auto-subscribe, and similar peer-service hooks — that a browser must never
 * reach. Compose after `requireAuth` so `req.user` is populated.
 */
export function requireServicePrincipal(req: Request, res: Response, next: NextFunction): void {
  if (!isServicePrincipal(req)) {
    // 403 (not 400) — this is an authorization refusal; status must match the
    // INSUFFICIENT_PERMISSIONS code and the sibling gates (requirePermission, etc.).
    return sendError(res, HttpStatus.FORBIDDEN, 'Internal service calls only', ErrorCode.INSUFFICIENT_PERMISSIONS);
  }
  next();
}
tagRouteGate(requireServicePrincipal, { kind: 'servicePrincipal' });

/**
 * THE gate for an INTERNAL route (#14) — the one every `/internal/*` path, the
 * quota usage counters, the entity-event ingest and the audit ingest go through.
 *
 * Two rules, both fail-closed:
 *
 *  1. **No user token, ever.** Not a member's, not a superadmin's, not a
 *     service-account key's. An internal route is a peer-service API surface, so
 *     "a sufficiently privileged human" is not an acceptable caller — that
 *     equivalence is exactly how a browser-reachable path becomes a tenant
 *     boundary bug. `requireServicePrincipal` already refused users; this also
 *     closes the `|| isSystemAdmin(req)` escape hatches that had grown around
 *     the individual internal routes.
 *  2. **Only the NAMED callers.** `callers` lists the services that legitimately
 *     call this route, and the name is cryptographically bound to the signing
 *     key (`services/service-keys.ts`), so this is an identity check rather than
 *     a claim check. It is the same allow-list the mesh policy names, at the
 *     layer that also holds in docker compose, where there is no mesh at all —
 *     the Istio `AuthorizationPolicy` is defence in depth on top, never the
 *     enforcement.
 *
 * Compose after `requireAuth` so `req.user` is populated. Refusals are counted
 * (`internal_route_refused_total`) and audited through the shared `authz.denied`
 * sink.
 */
export function requireInternalService(options: { callers: readonly string[] }) {
  const allowed = new Set(options.callers);
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    const refuse = (reason: 'unauthenticated' | 'user_token' | 'wrong_caller'): void => {
      emitCounter('internal_route_refused_total', {
        service: serviceIdentity(),
        route: req.route?.path ? `${req.method} ${req.baseUrl}${req.route.path}` : `${req.method} ${(req.originalUrl || req.url).split('?')[0]}`,
        reason,
        caller: serviceNameOf(req.user) ?? 'none',
      });
      recordAuthzDenial(req, `internal-service (${options.callers.join(', ')})`);
      if (reason === 'unauthenticated') {
        return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
      }
      logger.warn('Refused an internal route', { reason, path: (req.originalUrl || req.url).split('?')[0], caller: serviceNameOf(req.user) });
      return sendError(res, HttpStatus.FORBIDDEN, 'Internal service calls only', ErrorCode.INSUFFICIENT_PERMISSIONS);
    };

    if (!req.user) return refuse('unauthenticated');
    if (!isServicePrincipal(req)) return refuse('user_token');
    const caller = serviceNameOf(req.user);
    if (!caller || !allowed.has(caller)) return refuse('wrong_caller');
    next();
  }, { kind: 'servicePrincipal' }, { kind: 'internalService', callers: [...options.callers] });
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

/** Requires a system admin — granted solely by the `isSuperAdmin` token claim
 *  (the org-membership path was removed). Use after requireAuth. */
export function requireSystemAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isSystemAdmin(req)) {
    recordAuthzDenial(req, 'system-admin');
    return sendError(
      res, HttpStatus.FORBIDDEN,
      'Access denied. Only system administrators can perform this action.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }
  next();
}
tagRouteGate(requireSystemAdmin, { kind: 'systemAdmin' });

/**
 * Require a specific feature flag. Use after requireAuth.
 * Checks the `features` array in the JWT payload (set at token issuance).
 * Sysadmins (isSuperAdmin) bypass — they always have every feature.
 */
export function requireFeature(feature: string) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Authentication required', ErrorCode.UNAUTHORIZED);
    }

    // Sysadmins get all features; the `features` array on their token is
    // populated with every flag at issuance time but the bypass here keeps
    // the rule explicit and survives a token issued before a new feature
    // flag was added.
    if (req.user.isSuperAdmin === true) return next();

    if (!req.user.features?.includes(feature)) {
      // Route feature-gate denials through the same audit sink as
      // requirePermission / requireSystemAdmin so a probe for an
      // unentitled capability leaves a trail (state-changing methods only).
      recordAuthzDenial(req, `feature:${feature}`);
      return sendError(
        res, HttpStatus.FORBIDDEN,
        `This feature requires a higher plan (${feature})`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    next();
  }, { kind: 'feature', feature });
}

// ---------------------------------------------------------------------------
// Service-to-service tokens
//
// Inter-service HTTP calls (billing → message, platform → compliance, etc.)
// need to satisfy the same `requireAuth` middleware as user requests.
// `signServiceToken` mints a short-lived ES256 JWT signed with THIS service's
// OWN key (see `services/service-keys.ts`), carrying `principalType: 'service'`
// and naming the calling service via `sub: 'service:<name>'`. Gates branch on
// the claim; the subject names — and since #14 the name is cryptographically
// bound to the signing key, so it can also be trusted.
// `requireAuth` accepts these tokens transparently — they pass `decoded.sub`
// and `decoded.role` checks, and downstream `requireOrganization` /
// `requireSystemAdmin` rely on the org/role embedded in the token.
//
// Tokens default to 5-minute TTL — long enough to survive a backend hop,
// short enough that a leaked token is low-value.
// ---------------------------------------------------------------------------

const DEFAULT_SERVICE_TOKEN_TTL_SECONDS = 300;

/**
 * Denylist of service NAMES (the `<name>` in `sub: service:<name>`) whose tokens
 * `requireAuth` must reject. Read from `SERVICE_TOKEN_DENYLIST` (comma-separated)
 * at process start, so arming it is a config change + rollout — it cuts off a
 * compromised service WITHOUT rotating any key, and (unlike the pre-#14 shared
 * secret) without invalidating every other service's tokens as collateral.
 */
const serviceTokenDenylist = new Set(
  (process.env.SERVICE_TOKEN_DENYLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * The calling service's name for a SERVICE principal (`principalType: 'service'`),
 * else `undefined`. A user token never yields a name, whatever its `sub` says.
 */
export function serviceNameOf(claims: { principalType?: string; sub?: string } | undefined): string | undefined {
  if (claims?.principalType !== 'service' || typeof claims.sub !== 'string') return undefined;
  if (!claims.sub.startsWith(SERVICE_SUBJECT_PREFIX)) return undefined;
  return claims.sub.slice(SERVICE_SUBJECT_PREFIX.length) || undefined;
}

/** True when the claims are a service principal whose service is on the denylist. */
export function isServiceTokenDenied(claims: { principalType?: string; sub?: string }): boolean {
  if (serviceTokenDenylist.size === 0) return false;
  const name = serviceNameOf(claims);
  return name !== undefined && serviceTokenDenylist.has(name);
}

export interface ServiceTokenOptions {
  /** Calling service identifier (e.g. 'billing', 'platform'). Embedded as `sub: service:<name>`. */
  serviceName: string;
  /** Active org context for the call. Use the target tenant's org id, or the
   *  well-known `SYSTEM_ORG_ID` (an ObjectId) for system-wide ops — NOT the string
   *  'system', which id-based system-org checks won't recognize. */
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
  /**
   * Optional fine-grained permission claim. Prefer this + `role: 'member'` over a
   * high role when a call needs ONE specific capability (e.g. `['plugins:write']`
   * to push a plugin image) — the token then satisfies that permission gate
   * WITHOUT carrying `isAdmin`, so a leaked token can't perform admin actions.
   */
  permissions?: Permission[];
}

/**
 * Mint a JWT identifying the calling service. Used for inter-service HTTP calls.
 * The token satisfies `requireAuth` and (when orgId is present) `requireOrganization`.
 * Scope it with `opts.role` — least privilege keeps a leaked token low-value.
 *
 * `opts.serviceName` must be THIS process's own identity (`SERVICE_NAME`): a
 * service holds only its own signing key, so minting a token that names another
 * service throws rather than producing one every peer would reject. That is the
 * one behaviour change #14 forces on callers — see `services/service-keys.ts`.
 */
export function signServiceToken(opts: ServiceTokenOptions): string {
  const role = opts.role;
  const payload: Omit<JwtPayload, 'sub'> = {
    username: `${opts.serviceName}-service`,
    email: `${opts.serviceName}@internal`,
    principalType: 'service',
    token_use: 'access',
    role,
    isAdmin: role === 'owner' || role === 'admin',
    type: 'access',
    organizationId: opts.orgId,
    organizationName: opts.orgName ?? opts.orgId,
    // Unique token id on every mint. Combined with the short (300s default) TTL
    // this gives each service token a distinct identity — the correlation handle
    // for tracing which mint performed a cross-service action, and the building
    // block for replay detection (a verifier can track seen jtis). It does NOT
    // by itself prevent replay within the TTL window.
    jti: randomUUID(),
    // Least-privilege capability claim (optional) — lets a member-role token
    // satisfy a specific permission gate without carrying isAdmin.
    ...(opts.permissions && opts.permissions.length > 0 ? { permissions: opts.permissions } : {}),
  };
  // `sub`, `iat`/`exp` and the optional issuer/audience that requireAuth
  // verifies are stamped by the signer, so there is exactly one place that
  // decides what a service token says.
  return signServiceJwt(payload as Record<string, unknown>, {
    serviceName: opts.serviceName,
    expiresInSeconds: opts.ttlSeconds ?? DEFAULT_SERVICE_TOKEN_TTL_SECONDS,
    ...issuerAudienceOptions(),
  });
}

/** Convenience: returns a `Bearer <token>` header value for fetch/axios calls. */
export function getServiceAuthHeader(opts: ServiceTokenOptions): string {
  return `Bearer ${signServiceToken(opts)}`;
}

/** True when `req.user` is a service principal (`principalType: 'service'`, minted by `signServiceToken`). */
export function isServicePrincipal(req: Request): boolean {
  return req.user?.principalType === 'service';
}

/**
 * True when `req.user` is an ORG SERVICE ACCOUNT (`principalType:
 * 'service_account'`) — a non-human principal owned by one org, authenticating
 * with a `pb_sa_…` key exchanged at platform.
 *
 * A service account is NOT an internal service principal: it holds org Roles and
 * is subject to every permission gate a member is. What it can never do is
 * satisfy a HUMAN-presence requirement — step-up (and any later assurance gate)
 * refuses it outright, because there is no person behind it to re-verify.
 */
export function isServiceAccountPrincipal(req: Request): boolean {
  return req.user?.principalType === 'service_account';
}

/** True when `req.user` is the named internal service (e.g. `'billing'`). */
export function isServicePrincipalNamed(req: Request, serviceName: string): boolean {
  return serviceNameOf(req.user) === serviceName;
}

/**
 * PRE-auth check: cryptographically verify the request carries a valid, signed
 * SERVICE token (`principalType: 'service'`). Unlike {@link isServicePrincipal}
 * (which reads the already-populated `req.user`), this verifies the bearer token
 * itself, so it is safe to call BEFORE `requireAuth` runs — e.g. the global rate
 * limiter's `skip`, which must not trust the spoofable `x-internal-service`
 * header. Mirrors `requireAuth`'s SERVICE chain exactly (the signer's own key,
 * resolved by `kid`, with the `sub`/signer agreement check and the optional
 * issuer/audience) and returns `false` on any missing/invalid/non-service token
 * — including any platform-signed USER token, whose `kid` is not in the service
 * bundle at all. Stays SYNCHRONOUS, which is why the per-service public keys are
 * distributed as a mounted bundle rather than fetched over HTTP.
 */
export function verifyServicePrincipal(req: Request): boolean {
  const parts = req.headers.authorization?.split(' ');
  if (!parts || parts.length !== 2 || parts[0] !== 'Bearer') return false;
  try {
    const header = decodeJwtHeader(parts[1]);
    if (!header?.kid || !isServiceKid(header.kid)) return false;
    const decoded = verifyServiceJwt<JwtPayload>(parts[1], { kid: header.kid, ...issuerAudienceOptions() });
    if (decoded.type !== 'access' || decoded.principalType !== 'service' || !hasValidIdentityClaims(decoded)) return false;
    // A denylisted (killed) service must NOT be treated as a trusted principal —
    // otherwise it keeps the rate-limiter exemption even though requireAuth rejects
    // it on real routes. Fold the kill-switch into the pre-auth check too.
    return !isServiceTokenDenied(decoded);
  } catch {
    return false;
  }
}
