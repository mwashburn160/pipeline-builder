// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, sendError } from '@pipeline-builder/api-core';
import { createSharedRateLimitStore } from '@pipeline-builder/api-server';
import type { Request, RequestHandler } from 'express';
import rateLimit, { type Store } from 'express-rate-limit';
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

/** Counter bumped each time a limiter's shared store errors (the request is
 *  then let through — `passOnStoreError`). Label: `limiter`. */
export const RATE_LIMIT_STORE_ERROR_METRIC = 'rate_limit_store_error_total';

/**
 * Count a store failure. Like {@link countRejection}, never at the cost of the
 * request: no registry → nothing to count into.
 */
function countStoreError(name: string): void {
  try {
    incCounter(RATE_LIMIT_STORE_ERROR_METRIC, { limiter: name });
  } catch {
    // No registry — nothing to count into.
  }
}

/**
 * Wrap a shared store so every error it raises is COUNTED before it reaches
 * express-rate-limit (which, with `passOnStoreError`, lets the request through
 * unlimited and only logs). Without this a Redis outage silently turns every
 * limiter off; with it, `rate_limit_store_error_total{limiter}` pages. The error
 * is re-thrown unchanged, so the pass-through behaviour is exactly as before.
 *
 * Only the methods the wrapped store has are forwarded: express-rate-limit
 * reads the PRESENCE of optional methods as capabilities.
 */
export function withStoreErrorCounting(store: Store, name: string): Store {
  const counted = <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        countStoreError(name);
        throw err;
      }
    };
  const wrapped: Store = {
    increment: counted((key: string) => store.increment(key)),
    decrement: counted((key: string) => store.decrement(key)),
    resetKey: counted((key: string) => store.resetKey(key)),
    ...(store.init ? { init: (options) => store.init!(options) } : {}),
    ...(store.get ? { get: counted((key: string) => store.get!(key)) } : {}),
    ...(store.prefix !== undefined ? { prefix: store.prefix } : {}),
  };
  return wrapped;
}

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
 * before it shows up in a support ticket. Every STORE failure (the request was
 * let through unlimited) is counted on `rate_limit_store_error_total{limiter}`.
 * Password sign-in does not rely on this limiter alone: the per-account
 * Mongo-backed lockout (helpers/password-lockout.ts) bounds guessing even while
 * the store is failing open.
 */
export function createLimiter(opts: LimiterOptions): RequestHandler {
  const shared = createSharedRateLimitStore(`platform:${opts.name}`);
  return rateLimit({
    ...(shared ? { store: withStoreErrorCounting(shared, opts.name) } : {}),
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
