// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every rate-limit BUCKET platform serves, and the requests each one exempts.
 *
 * Kept next to `createLimiter` and the key generators (`rate-limit-keys.ts`)
 * rather than inline in `index.ts`, so the whole rate-limiting policy — which
 * request lands in which bucket, and why some land in none — reads in one
 * place; `index.ts` only wires them into the app.
 */

import type { Request, RequestHandler } from 'express';

import { rateLimitKey, scimOrgKey, verifiedIsSuperAdmin, tierLimitedMax } from './rate-limit-keys.js';
import { createLimiter } from './rate-limiter.js';
import { config } from '../config/index.js';
import { SCIM_RATE_LIMIT_MAX, SCIM_RATE_LIMIT_WINDOW_MS } from '../constants/scim.js';
import { SCIM_PATH } from '../routes/mount.js';

/**
 * The device-authorization poll. RFC 8628 has the waiting client poll every few
 * seconds until the person approves in a browser — ~120 requests over one
 * sign-in, against a general bucket of 100 per 15 minutes for an anonymous
 * caller. It has its own per-device-code and per-IP limiters on the router
 * (`routes/device-auth.ts`), which is where the abuse ceiling belongs; counting
 * it here would 429 every legitimate CLI login halfway through.
 */
function isDevicePoll(req: Request): boolean {
  return req.method === 'POST' && req.path === '/auth/device/token';
}

/**
 * The SCIM surface. An identity provider's initial import is a burst of
 * hundreds of requests, all from one org — against a general bucket sized for a
 * person's interactive use. It has its own per-org bucket (`scimLimiter`), so a
 * directory sync can neither be throttled by, nor starve, the org's people.
 */
function isScim(req: Request): boolean {
  return req.path.startsWith(SCIM_PATH);
}

/** General rate limiter — per-tier max, keyed by org (or IP for anon callers).
 *  Applied to EVERY route; SCIM has its own per-surface bucket below. */
export const generalLimiter: RequestHandler = createLimiter({
  name: 'general',
  windowMs: config.rateLimit.windowMs,
  max: tierLimitedMax,
  keyGenerator: rateLimitKey,
  // Sysadmins are internal operators who legitimately make burst calls
  // (audit replays, fleet-wide scans). Bypass the limiter rather than size it
  // for the worst case. The alert relay has its own generous bucket; it must
  // not share the anonymous user budget. The sysadmin check VERIFIES the token:
  // the bypass removes throttling entirely, so a forged `isSuperAdmin:true`
  // must not grant it. `requireAuth` still authorizes the request later.
  skip: (req: Request) => isDevicePoll(req) || isScim(req) || verifiedIsSuperAdmin(req),
  message: 'Too many requests. Please try again later.',
});

// The `/auth*` buckets are attached route by route — see `auth-limiters.ts`.

/**
 * Per-ORG limiter for SCIM. Keyed by the VERIFIED token's org — never the
 * service account — because the plan's requirement is a per-ORG ceiling: a tenant
 * that issues five SCIM keys still gets one directory-sync budget. Falls back to
 * the credential hash / client IP for a request whose token doesn't verify (which
 * `requireScimScope` then refuses anyway).
 */
export const scimLimiter: RequestHandler = createLimiter({
  name: 'scim',
  windowMs: SCIM_RATE_LIMIT_WINDOW_MS,
  max: SCIM_RATE_LIMIT_MAX,
  keyGenerator: scimOrgKey,
  message: 'SCIM rate limit exceeded for your organization. Slow the provisioning job down and retry.',
});
