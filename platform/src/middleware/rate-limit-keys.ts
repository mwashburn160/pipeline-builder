// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isValidTier } from '@pipeline-builder/api-core';
import type express from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';

import { config } from '../config/index.js';

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
 * missing/malformed token. Only `verifiedIsSuperAdmin` verifies a signature,
 * because only it grants an actual privilege (the throttle bypass).
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

/**
 * Best-effort organizationId extraction for rate-limit bucketing.
 *
 * Runs BEFORE auth middleware, so this peeks at the Bearer token without
 * verifying the signature. Used only as a rate-limit key; real authorization
 * still happens in requireAuth. Falls back to IP-based keying when
 * - no Bearer token,
 * - the token is malformed,
 * - the payload doesn't include organizationId.
 *
 * Net effect: a single noisy authenticated org consumes its own quota window
 * instead of degrading every other tenant sharing an IP (NAT / corp gateway).
 *
 * Forging an `organizationId` here only moves the forger into that org's
 * bucket — it cannot raise a limit, so an unverified peek is safe.
 */
export function rateLimitKey(req: express.Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const parts = token.split('.');
    if (parts.length === 3 && parts[1]) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { organizationId?: string };
        if (typeof payload.organizationId === 'string' && payload.organizationId.length > 0) {
          return `org:${payload.organizationId.toLowerCase()}`;
        }
      } catch {
        // Malformed JWT — fall through to IP keying.
      }
    }
  }
  return `ip:${extractClientIp(req)}`;
}

/**
 * Peek at the JWT payload (unverified — signature checked later in `requireAuth`)
 * to extract the issuer-stamped tier + role for rate-limit dispatching.
 * Same caveat as `rateLimitKey`: this runs BEFORE auth middleware, so it must
 * tolerate missing / malformed tokens; the limit decision falls back to the
 * developer tier when no signal is available.
 */
export function peekJwtClaims(req: express.Request): {
  tier?: string;
  role?: string;
  organizationId?: string;
  organizationName?: string;
  isSuperAdmin?: boolean;
  impersonationReadOnly?: boolean;
} {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return {};
  const token = auth.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
      tier?: string;
      role?: string;
      organizationId?: string;
      organizationName?: string;
      isSuperAdmin?: boolean;
      impersonationReadOnly?: boolean;
    };
  } catch {
    return {};
  }
}

/**
 * Whether the request carries a VALID (signature-verified) access token with the
 * `isSuperAdmin` flag. Used only for the rate-limit bypass, which must not honor a
 * forged token. Unlike `peekJwtClaims` (unverified — fine for tier/key selection),
 * this verifies against the same secret + pinned algorithm as `requireAuth`.
 */
export function verifiedIsSuperAdmin(req: express.Request): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  try {
    const payload = jwt.verify(auth.slice(7), config.auth.jwt.secret, {
      algorithms: [config.auth.jwt.algorithm],
    }) as { isSuperAdmin?: boolean };
    return payload.isSuperAdmin === true;
  } catch {
    return false;
  }
}

/**
 * Per-tier max calculator. JWT carries `tier` (set at issuance from the
 * org's planId); we multiply the baseline by the tier's multiplier so a
 * premium org gets proportionally more burst. Sysadmins bypass entirely
 * (see the limiter's `skip`).
 *
 * `tier` is a JWT claim and arrives untyped — narrow via api-core's
 * `isValidTier` guard before indexing the strongly-typed
 * `Record<QuotaTier, number>`. Unknown tiers fall back to 1× (developer
 * baseline), keeping a renamed-but-not-deployed tier from accidentally
 * getting an unlimited budget.
 */
export function tierLimitedMax(req: express.Request): number {
  const { tier } = peekJwtClaims(req);
  const mult: number = (tier && isValidTier(tier) ? config.rateLimit.tierMultipliers[tier] : 1) || 1;
  return Math.max(1, Math.floor(config.rateLimit.max * mult));
}
