// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isValidTier } from '@pipeline-builder/api-core';
import type express from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import { config } from '../config/index.js';
import { verifyPlatformJwt } from '../utils/jwt-options.js';

/**
 * Rate-limit key/bucket selection, extracted from `index.ts`.
 *
 * These ran inline in the app bootstrap, which meant nothing could import
 * them and nothing tested them — and that is precisely where a header-trust
 * bug went unnoticed: `extractClientIp` used to prefer the raw
 * `X-Forwarded-For` over `req.ip`, which made the auth limiter bypassable
 * (see `extractClientIp`).
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
  tier?: string;
  role?: string;
  organizationId?: string;
  organizationName?: string;
  isSuperAdmin?: boolean;
  impersonationReadOnly?: boolean;
}

/**
 * Peek at the JWT payload WITHOUT verifying it. Only for pre-auth hints that
 * grant nothing (tenant-context hints, the impersonation write fence that
 * `requireAuth` re-checks) — never for anything a forged token could exploit.
 * Tolerates missing / malformed tokens by returning `{}`.
 */
export function peekJwtClaims(req: express.Request): TokenClaims {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return {};
  const parts = auth.slice(7).split('.');
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
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = verifyPlatformJwt<TokenClaims>(auth.slice(7));
      if (payload.type === 'access') claims = payload;
    } catch {
      // Invalid / expired / forged — treated as anonymous.
    }
  }
  verifiedClaimsCache.set(req, claims);
  return claims;
}

/**
 * Rate-limit bucket: the verified token's org, else the client IP.
 *
 * Net effect: a single noisy authenticated org consumes its own quota window
 * instead of degrading every other tenant sharing an IP (NAT / corp gateway),
 * while an unverified or forged token is bucketed by IP like any anonymous
 * caller.
 */
export function rateLimitKey(req: express.Request): string {
  const orgId = verifiedAccessClaims(req)?.organizationId;
  if (typeof orgId === 'string' && orgId.length > 0) return `org:${orgId.toLowerCase()}`;
  return `ip:${extractClientIp(req)}`;
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
