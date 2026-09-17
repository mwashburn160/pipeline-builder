// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, sendError } from '@pipeline-builder/api-core';
import { createSharedRateLimitStore } from '@pipeline-builder/api-server';
import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { extractClientIp } from './rate-limit-keys.js';

export interface LimiterOptions {
  /** Bucket namespace in the shared store (`platform:<name>`). */
  name: string;
  windowMs: number;
  max: number | ((req: Request) => number);
  keyGenerator: (req: Request) => string;
  skip?: (req: Request) => boolean;
  /** 429 message, sent through `sendError` (`RATE_LIMIT_EXCEEDED`). */
  message: string;
}

/**
 * The one way platform builds a rate limiter: a Redis-shared store (so limits
 * hold across replicas; a store outage lets requests through rather than
 * failing every request), standard `RateLimit-*` headers, and a 429 in the
 * standard `sendError` shape.
 */
export function createLimiter(opts: LimiterOptions): RequestHandler {
  return rateLimit({
    store: createSharedRateLimitStore(`platform:${opts.name}`),
    passOnStoreError: true,
    windowMs: opts.windowMs,
    max: opts.max,
    keyGenerator: opts.keyGenerator,
    ...(opts.skip ? { skip: opts.skip } : {}),
    handler: (_req, res) => sendError(res, 429, opts.message, ErrorCode.RATE_LIMIT_EXCEEDED),
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
