// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError, ErrorCode, verifyServicePrincipal } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createSharedRateLimitStore } from './rate-limit-store.js';

/** Config for a {@link rateLimitByOrg} limiter. */
export interface OrgRateLimitOptions {
  /** Unique name — namespaces the Redis bucket + labels logs. */
  name: string;
  /** Max requests per window per org (or per client IP when unauthenticated). */
  max: number;
  /** Window length in ms. */
  windowMs: number;
  /** Optional 429 message override. */
  message?: string;
}

/**
 * Per-ORGANIZATION rate limiter for a specific hot/expensive route, keyed on the
 * VERIFIED auth org — the complement to the coarse global per-IP limiter in
 * `createApp` (which a whole org behind one NAT shares, and a distributed
 * attacker spreads across IP buckets to evade).
 *
 * MUST be mounted AFTER `requireAuth` so `req.user.organizationId` is populated;
 * an unauthenticated caller falls back to a client-IP bucket (never a spoofable
 * header) so it stays bounded. Verified internal service principals are exempt
 * (they carry a signed service JWT). Uses the shared env Redis store
 * (cross-replica, namespaced by `name`) when configured, else in-memory.
 *
 * @example
 *   router.post('/', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'),
 *     rateLimitByOrg({ name: 'message-send', max: 60, windowMs: 60_000 }),
 *     withRoute(handler));
 */
export function rateLimitByOrg(opts: OrgRateLimitOptions) {
  const { name, max, windowMs, message } = opts;

  const options: Parameters<typeof rateLimit>[0] = {
    max,
    windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    // Exempt cryptographically-verified internal service callers (signed JWT).
    skip: (req: Request) => verifyServicePrincipal(req),
    // Redis store failure degrades to "not limited", never a 500 on the route.
    passOnStoreError: true,
    // Bucket by VERIFIED org (set by requireAuth), NOT the spoofable `x-org-id`
    // header. Fall back to a normalized client-IP bucket when unauthenticated so
    // the limiter still bounds pre-auth traffic. Namespaced (`org:`/`ip:`) so an
    // IP literal can never collide with an org id.
    keyGenerator: (req: Request): string => {
      const orgId = req.user?.organizationId;
      return orgId ? `org:${orgId.toLowerCase()}` : `ip:${ipKeyGenerator(req.ip || 'anon', 64)}`;
    },
    handler: (_req: Request, res: Response): void => {
      sendError(res, 429, message ?? `Too many ${name} requests, please slow down.`, ErrorCode.RATE_LIMIT_EXCEEDED);
    },
  };

  // Shared cross-replica store (one process-wide Redis connection) when Redis is
  // configured, else per-process memory. Namespaced by service AND limiter name so
  // distinct limiters — or same-named limiters in different services — never
  // share a counter.
  options.store = createSharedRateLimitStore(`${process.env.SERVICE_NAME || 'api'}:${name}`);

  return rateLimit(options);
}
