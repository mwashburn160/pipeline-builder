// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, sendError } from '@pipeline-builder/api-core';
import { createSharedRateLimitStore } from '@pipeline-builder/api-server';
import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { extractClientIp } from './rate-limit-keys.js';
import { incCounter } from '../observability/metrics.js';

export interface LimiterOptions {
  /** Bucket namespace in the shared store (`platform:<name>`). Also the
   *  `limiter` label on `platform_rate_limit_rejected_total`. */
  name: string;
  windowMs: number;
  max: number | ((req: Request) => number);
  keyGenerator: (req: Request) => string;
  skip?: (req: Request) => boolean;
  /**
   * Count only requests that FAIL (status >= 400). For a bucket that defends
   * against GUESSING a credential: a correct guess is not what the bucket is
   * for, so a person who signs in successfully never spends it.
   */
  skipSuccessfulRequests?: boolean;
  /** 429 message, sent through `sendError` (`RATE_LIMIT_EXCEEDED`). */
  message: string;
}

/** Name of the counter every platform limiter bumps when it refuses a request. */
export const RATE_LIMIT_REJECTED_METRIC = 'platform_rate_limit_rejected_total';

/**
 * The ROUTE a refused request was for, as a bounded label: the matched route
 * pattern (`/auth/webauthn/login/verify`, `/auth/sso/:orgId/callback`), never
 * the raw URL, which carries ids and would explode the series count. A limiter
 * mounted ahead of routing (the root `generalLimiter`) has no matched route
 * yet, so it reports `unrouted`.
 */
export function rejectedRouteLabel(req: Request): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  return typeof pattern === 'string' ? `${req.baseUrl ?? ''}${pattern}` : 'unrouted';
}

/** Seconds until the caller's bucket drains, from the limiter's own reset time. */
function retryAfterSeconds(req: Request, windowMs: number): number {
  const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const ms = reset instanceof Date ? reset.getTime() - Date.now() : windowMs;
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Count a refusal. Never at the cost of the refusal itself: the metrics
 * registry is wired at app boot, and a limiter running outside it (a test, an
 * operator script) must still answer 429 rather than throw.
 */
function countRejection(name: string, req: Request): void {
  try {
    incCounter(RATE_LIMIT_REJECTED_METRIC, { limiter: name, route: rejectedRouteLabel(req) });
  } catch {
    // No registry — nothing to count into.
  }
}

/**
 * The one way platform builds a rate limiter: a Redis-shared store (so limits
 * hold across replicas; a store outage lets requests through rather than
 * failing every request), standard `RateLimit-*` headers plus `Retry-After`,
 * and a 429 in the standard `sendError` shape whose `details.retryAfterSeconds`
 * says how long to wait — so the client can tell the person "try again in 12
 * minutes" instead of "later".
 *
 * Every refusal is counted on `platform_rate_limit_rejected_total{limiter,route}`,
 * so a route that starts spending a bucket it shouldn't shows up on a dashboard
 * before it shows up in a support ticket.
 */
export function createLimiter(opts: LimiterOptions): RequestHandler {
  return rateLimit({
    store: createSharedRateLimitStore(`platform:${opts.name}`),
    passOnStoreError: true,
    windowMs: opts.windowMs,
    max: opts.max,
    keyGenerator: opts.keyGenerator,
    ...(opts.skip ? { skip: opts.skip } : {}),
    ...(opts.skipSuccessfulRequests ? { skipSuccessfulRequests: true } : {}),
    handler: (req, res) => {
      countRejection(opts.name, req);
      sendError(res, 429, opts.message, ErrorCode.RATE_LIMIT_EXCEEDED, {
        retryAfterSeconds: retryAfterSeconds(req, opts.windowMs),
      });
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

/**
 * Key for limiters mounted AFTER `requireAuth`: the authenticated user, falling
 * back to the client IP (see `extractClientIp`) for the unreachable anonymous
 * case.
 */
export function userOrIpKey(req: Request): string {
  return req.user?.sub ?? extractClientIp(req);
}
