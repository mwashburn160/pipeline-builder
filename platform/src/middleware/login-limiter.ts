// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PER-ACCOUNT throttle for password sign-in (`POST /auth/login`).
 *
 * `/auth/*` already sits behind the per-IP auth limiter (index.ts
 * `authLimiter`, `AUTH_LIMITER_*`), which stops one address hammering the
 * endpoint. It cannot stop a credential-stuffing or password-spraying run that
 * rotates addresses against ONE account — every attempt lands in a fresh IP
 * bucket. This bucket is keyed on the ACCOUNT instead.
 *
 *  - Keyed on a SHA-256 of the normalized identifier (trimmed, lowercased): the
 *    shared Redis store never holds a raw email/username, and `Alice@x.com`,
 *    `alice@x.com ` and `alice@x.com` share one bucket. (A username and an email
 *    for the same account are two buckets — the per-IP limiter still bounds the
 *    sum per address.)
 *  - Counts only FAILED attempts (`skipSuccessfulRequests`): an owner signing in
 *    correctly never consumes it, so the budget exists purely for guessing. A
 *    second-factor challenge or a forced password change answers 200 — the
 *    password was right — and is not counted either.
 *  - Redis-shared across replicas via the same store every platform limiter
 *    uses; a store outage lets requests through (`passOnStoreError`), with the
 *    per-IP limiter still in force.
 *
 * The trade-off is the classic one: someone who knows an identifier can burn
 * its bucket and delay the real owner's PASSWORD sign-in for one window.
 * Passkey, social and SSO sign-in are unaffected, and the window is short.
 */

import { createHash } from 'crypto';
import { ErrorCode, sendError } from '@pipeline-builder/api-core';
import { createSharedRateLimitStore } from '@pipeline-builder/api-server';
import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { extractClientIp } from './rate-limit-keys.js';
import { config } from '../config/index.js';

/** The bucket key for a login request: the hashed identifier, else the client IP. */
export function loginAccountKey(req: Request): string {
  const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : '';
  if (!identifier) return extractClientIp(req);
  return `a:${createHash('sha256').update(identifier).digest('hex')}`;
}

export const loginAccountLimiter: RequestHandler = rateLimit({
  store: createSharedRateLimitStore('platform:login-account'),
  passOnStoreError: true,
  windowMs: config.auth.loginThrottle.perAccountWindowMs,
  max: config.auth.loginThrottle.perAccountMax,
  keyGenerator: loginAccountKey,
  skipSuccessfulRequests: true,
  handler: (_req, res) => sendError(
    res, 429,
    'Too many failed sign-in attempts for this account. Please wait a few minutes, or sign in with a passkey.',
    ErrorCode.RATE_LIMIT_EXCEEDED,
  ),
  standardHeaders: true,
  legacyHeaders: false,
});
