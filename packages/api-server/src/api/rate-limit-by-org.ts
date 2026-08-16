// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError, ErrorCode, createLogger, verifyServicePrincipal, createEnvRedisClient, safeCreateRequire } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

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

  // Shared Redis store for cross-replica buckets when Redis is configured;
  // namespaced per limiter so distinct limiters don't share a bucket. Fail-open:
  // no Redis / a load failure falls back to per-process in-memory limiting.
  const redis = createEnvRedisClient<{ call: (...args: unknown[]) => Promise<unknown> }>(`rate-limit-${name}`);
  if (redis) {
    try {
      const require = safeCreateRequire(import.meta.url);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RedisStore } = require('rate-limit-redis');
      options.store = new RedisStore({
        prefix: `rl:${name}:`,
        sendCommand: (...args: string[]) => redis.call(...args),
      });
    } catch {
      logger.warn('Redis store unavailable; per-org limiter falls back to in-memory', { name });
    }
  }

  return rateLimit(options);
}
