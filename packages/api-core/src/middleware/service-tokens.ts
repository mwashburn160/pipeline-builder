// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Service-to-service tokens and service-principal checks.
 */

import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { SERVICE_SUBJECT_PREFIX, isServiceKid, signServiceJwt, verifyServiceJwt } from '../services/service-keys.js';
import { type JwtPayload } from '../types/common.js';
import { type Permission } from '../types/permissions.js';
import { decodeJwtHeader } from '../utils/jwk.js';
import { hasValidIdentityClaims, issuerAudienceOptions } from './jwt-verify.js';
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
 * compromised service WITHOUT rotating any key, and without invalidating every
 * other service's tokens as collateral.
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
