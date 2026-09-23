// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { hashApiKey, isOpaqueApiKey, isValidTier } from '@pipeline-builder/api-core';
import type express from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import { config } from '../config/index.js';
import { verifyPlatformJwt } from '../utils/jwt-options.js';

/**
 * Rate-limit key/bucket selection, in its own module so it can be tested:
 * header trust is where a limiter becomes bypassable (a raw
 * `X-Forwarded-For` preferred over `req.ip` — see `extractClientIp`).
 *
 * All of these run BEFORE `requireAuth`, so every one must tolerate a
 * missing/malformed token. Everything that selects a bucket or a limit uses
 * VERIFIED claims (`verifiedAccessClaims`); `peekJwtClaims` is for hints that
 * grant nothing.
 */

/**
 * The client IP for rate-limit bucketing.
 *
 * Reads ONLY `req.ip`. Express derives that from `X-Forwarded-For` according
 * to the `trust proxy` setting (`config.server.trustProxy`, default 1), which
 * means it takes the last-but-`trustProxy` entry — the one written by OUR
 * ingress — and ignores anything the client prepended.
 *
 * Do NOT read `req.headers['x-forwarded-for']` here. Both ingress configs use
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`, which
 * APPENDS, so a client-supplied value survives as element 0. Parsing the
 * leftmost entry therefore let a caller mint a fresh bucket per request by
 * varying the header, defeating the 20-per-15-minute auth limiter on
 * `/auth/login`, `/auth/register` and the OAuth callbacks.
 *
 * Always route the final value through `ipKeyGenerator`: express-rate-limit
 * 8.x's validator refuses to start if a custom keyGenerator touches `req.ip`
 * without calling this helper (it normalizes IPv6 to a /64 prefix so one user
 * can't burn the bucket by rotating low bits). Skipping it raises
 * ERR_ERL_KEY_GEN_IPV6 at boot even on IPv4 — the validator doesn't
 * introspect, it just checks the helper was invoked.
 */
export function extractClientIp(req: express.Request): string {
  return ipKeyGenerator(req.ip || 'unknown', 64);
}

/** Claims read from a token for peeking (unverified) or bucketing (verified). */
export interface TokenClaims {
  type?: string;
  /** Subject — a user id, or a service account's id on a `service_account` token. */
  sub?: string;
  /** Which kind of principal the token speaks for (see api-core `PrincipalType`). */
  principalType?: string;
  tier?: string;
  role?: string;
  organizationId?: string;
  organizationName?: string;
  isSuperAdmin?: boolean;
  impersonationReadOnly?: boolean;
}

/**
 * The credential from an `Authorization: Bearer <value>` header, or undefined
 * when the header is absent or is some other scheme. Everything below reads the
 * header through this, so no caller re-derives the offset.
 */
function bearerCredential(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/**
 * Peek at the JWT payload WITHOUT verifying it. Only for pre-auth hints that
 * grant nothing (tenant-context hints, the impersonation write fence that
 * `requireAuth` re-checks) — never for anything a forged token could exploit.
 * Tolerates missing / malformed tokens by returning `{}`.
 */
export function peekJwtClaims(req: express.Request): TokenClaims {
  const credential = bearerCredential(req);
  if (credential === undefined) return {};
  const parts = credential.split('.');
  if (parts.length !== 3 || !parts[1]) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as TokenClaims;
  } catch {
    return {};
  }
}

/** Per-request memo: the skip, key and max callbacks all ask for the same token. */
const verifiedClaimsCache = new WeakMap<express.Request, TokenClaims | null>();

/**
 * The claims of a VALID (signature-verified, `type: 'access'`) access token, or
 * `null` when there is no token or it does not verify. Same secret, pinned
 * algorithm, issuer/audience and rotation as `requireAuth`.
 *
 * Everything that decides a LIMIT goes through this: the bucket key, the tier
 * multiplier and the sysadmin bypass. An unverified peek there would let a caller
 * mint a fresh bucket per request (random `organizationId`) or claim
 * `tier: 'unlimited'`.
 */
export function verifiedAccessClaims(req: express.Request): TokenClaims | null {
  const cached = verifiedClaimsCache.get(req);
  if (cached !== undefined) return cached;
  let claims: TokenClaims | null = null;
  const credential = bearerCredential(req);
  if (credential !== undefined) {
    try {
      const payload = verifyPlatformJwt<TokenClaims>(credential);
      if (payload.type === 'access') claims = payload;
    } catch {
      // Invalid / expired / forged — treated as anonymous.
    }
  }
  verifiedClaimsCache.set(req, claims);
  return claims;
}

/**
 * Rate-limit bucket, most specific first:
 *
 *  1. `key:<sha256>` — an OPAQUE access key presented directly to platform. It
 *     can't be decoded pre-auth, but a key belongs to exactly one principal, so
 *     hashing it gives a per-credential (and therefore per-service-account)
 *     bucket without a DB read. Hashed, never the secret itself: the bucket id
 *     reaches the shared Redis store.
 *  2. `sa:<id>` — a verified SERVICE-ACCOUNT token. Its traffic is bucketed per
 *     ACCOUNT, not per org, so one runaway automation cannot consume the window
 *     its org's people share (and each account is bounded on its own).
 *  3. `org:<id>` — any other verified token: a noisy tenant consumes its own
 *     window instead of degrading everyone behind a shared IP (NAT / gateway).
 *  4. `ip:<addr>` — anonymous, unverified or forged.
 */
export function rateLimitKey(req: express.Request): string {
  const credential = bearerCredential(req);
  if (credential !== undefined && isOpaqueApiKey(credential)) return `key:${hashApiKey(credential)}`;
  const claims = verifiedAccessClaims(req);
  if (claims?.principalType === 'service_account' && typeof claims.sub === 'string' && claims.sub.length > 0) {
    return `sa:${claims.sub}`;
  }
  const orgId = claims?.organizationId;
  if (typeof orgId === 'string' && orgId.length > 0) return `org:${orgId.toLowerCase()}`;
  return `ip:${extractClientIp(req)}`;
}

/**
 * SCIM bucket: the VERIFIED token's ORG, not the service account.
 *
 * `rateLimitKey` deliberately buckets a service account on its own, so one
 * runaway automation can't spend its org's window. SCIM is the opposite
 * requirement — the plan asks for a limit "per org on the SCIM endpoints", and an
 * org that mints five SCIM keys must still get ONE directory-sync budget, or the
 * ceiling is trivially raised by issuing more keys. Falls back to the credential
 * hash (an opaque key presented directly) and then the client IP, for requests
 * `requireScimScope` is about to refuse anyway.
 */
export function scimOrgKey(req: express.Request): string {
  const orgId = verifiedAccessClaims(req)?.organizationId;
  if (typeof orgId === 'string' && orgId.length > 0) return `scim-org:${orgId.toLowerCase()}`;
  const credential = bearerCredential(req);
  if (credential !== undefined && isOpaqueApiKey(credential)) return `scim-key:${hashApiKey(credential)}`;
  return `scim-ip:${extractClientIp(req)}`;
}

/**
 * Whether the request carries a verified access token with `isSuperAdmin`. Used
 * only for the rate-limit bypass; `requireAuth` still authorizes the request.
 */
export function verifiedIsSuperAdmin(req: express.Request): boolean {
  return verifiedAccessClaims(req)?.isSuperAdmin === true;
}

/**
 * Per-tier max: the baseline multiplied by the verified token's tier multiplier
 * (set at issuance from the org's plan). Sysadmins bypass entirely (see the
 * limiter's `skip`).
 *
 * `tier` is narrowed via api-core's `isValidTier` before indexing the
 * `Record<QuotaTier, number>`. No verified token, or an unknown tier, gets the
 * base 1× budget — so neither a forged `tier: 'unlimited'` nor a renamed tier
 * can raise a limit.
 */
export function tierLimitedMax(req: express.Request): number {
  const tier = verifiedAccessClaims(req)?.tier;
  const mult: number = (tier && isValidTier(tier) ? config.rateLimit.tierMultipliers[tier] : 1) || 1;
  return Math.max(1, Math.floor(config.rateLimit.max * mult));
}

/**
 * Signing OUT. Neither path guesses a credential — `/auth/logout` ends a session
 * the caller already holds, and `/auth/sso/logout` only asks whether that
 * session has an IdP to redirect to — so neither is what this limiter defends
 * against. Counting them produced the opposite of safety: sign-out spends TWO
 * attempts of the per-IP budget (the app asks for the SLO redirect first), so a
 * few sign-out/sign-in cycles locked the person out of LOGIN, and the only way
 * back was waiting out the window or deleting the Redis keys by hand. Being
 * rate-limited out of leaving is not a security property worth having.
 */
export function isSignOut(req: express.Request): boolean {
  return req.method === 'POST' && (req.path === '/auth/logout' || req.path === '/auth/sso/logout');
}

