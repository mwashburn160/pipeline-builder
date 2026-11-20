// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, sendError, ErrorCode, verifyServicePrincipal } from '@pipeline-builder/api-core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createSharedRateLimitStore } from './rate-limit-store.js';

const logger = createLogger('rate-limit-by-org');

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
  /**
   * What one bucket is (default `org`):
   *  - `org`  — the verified org (an org service account gets its own bucket);
   *  - `user` — the verified caller (`sub`), for per-person caps;
   *  - `ip`   — the TRUSTED client IP (`req.ip`, resolved by the app's
   *             `trust proxy` setting — never a raw forwarding header), for
   *             per-address caps that a user can't reset by switching orgs.
   * Every mode falls back to the client-IP bucket for an unauthenticated caller.
   */
  keyBy?: 'org' | 'user' | 'ip';
  /**
   * What a store error (the shared Redis store unreachable) does. Default
   * (false): the request passes unlimited — a limiter outage never fails a
   * route. true: the request is refused with 503 SERVICE_UNAVAILABLE — for a
   * limit that guards a security-sensitive write and must never silently lift.
   */
  failClosed?: boolean;
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
export function rateLimitByOrg(opts: OrgRateLimitOptions): RequestHandler {
  const { name, max, windowMs, message, keyBy = 'org', failClosed = false } = opts;

  const options: Parameters<typeof rateLimit>[0] = {
    max,
    windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    // Exempt cryptographically-verified internal service callers (signed JWT).
    skip: (req: Request) => verifyServicePrincipal(req),
    // Redis store failure degrades to "not limited", never a 500 on the route —
    // unless the limiter fails closed (then the error reaches the wrapper below).
    passOnStoreError: !failClosed,
    // Bucket by VERIFIED identity (set by requireAuth), NOT the spoofable
    // `x-org-id` header. An ORG SERVICE ACCOUNT gets its OWN bucket rather than
    // its org's: automation is exactly the traffic shape that would otherwise
    // drain the window its org's people share, and the plan requires machine
    // rate limits to be keyed per account. Falls back to a normalized client-IP
    // bucket when unauthenticated so pre-auth traffic is still bounded.
    // Namespaced (`sa:`/`org:`/`ip:`) so no two id spaces can collide.
    keyGenerator: (req: Request): string => {
      const ip = `ip:${ipKeyGenerator(req.ip || 'anon', 64)}`;
      if (keyBy === 'ip') return ip;
      if (keyBy === 'user') return req.user?.sub ? `user:${req.user.sub}` : ip;
      if (req.user?.principalType === 'service_account' && req.user.sub) return `sa:${req.user.sub}`;
      const orgId = req.user?.organizationId;
      return orgId ? `org:${orgId.toLowerCase()}` : ip;
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

  const limiter = rateLimit(options);
  if (!failClosed) return limiter;
  // Fail closed: a store error is answered 503 here (never a 500, never unlimited).
  return (req: Request, res: Response, next: NextFunction): void => {
    void limiter(req, res, (err?: unknown) => {
      if (err === undefined || err === null) return next();
      logger.warn('Rate-limit store unavailable; refusing (fail-closed limiter)', { name, error: errorMessage(err) });
      sendError(res, 503, 'This action is temporarily unavailable; try again shortly.', ErrorCode.SERVICE_UNAVAILABLE);
    });
  };
}
