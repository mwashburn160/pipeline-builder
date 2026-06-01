// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, sendError } from '@pipeline-builder/api-core';
import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { login, logout, register, refresh, switchOrg, sendVerificationEmail, verifyEmail } from '../controllers';
import { stepUpVerify } from '../controllers/step-up';
import { requireAuth, isValidRefreshToken } from '../middleware';

const router = Router();

/**
 * Tight per-user limiter for /auth/step-up.
 *
 * The endpoint accepts raw passwords from an already-authenticated
 * session. The global `authLimiter` (20 req / 15 min, IP-keyed) is too
 * loose for brute-force protection here — a session pivoter sharing an
 * IP with legitimate users could burn the budget. Per-user keying with
 * a much tighter window matches the docstring's "4 attempts / minute"
 * promise (we go 5 to allow for fat-fingers + retry on transient err).
 *
 * On limit-hit returns 429; the StepUpModal surfaces the message verbatim.
 */
const stepUpLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  // requireAuth runs BEFORE this middleware in the chain, so req.user is
  // populated already. Fall back to IP for the (unreachable) anon case;
  // route through ipKeyGenerator because express-rate-limit 8.x's validator
  // refuses to start otherwise (see platform/src/index.ts:extractClientIp).
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip || 'anon', 64),
  // Surface the limit through `sendError` so the body matches the standard
  // `{ success: false, statusCode, errorCode, message }` shape every other
  // 429 in the platform emits. Without this, the raw object above ships
  // instead of a sendError-shaped one.
  handler: (_req, res) => {
    sendError(
      res, 429,
      'Too many step-up attempts. Please wait a minute and try again.',
      ErrorCode.RATE_LIMIT_EXCEEDED,
    );
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/** POST /auth/register - Create a new user account */
router.post('/register', register);

/** POST /auth/login - Authenticate and receive tokens */
router.post('/login', login);

/** POST /auth/refresh - Exchange refresh token for new access token */
router.post('/refresh', isValidRefreshToken, refresh);

/** POST /auth/logout - Invalidate current session */
router.post('/logout', requireAuth, logout);

/** POST /auth/switch-org - Switch active organization and re-issue tokens */
router.post('/switch-org', requireAuth, switchOrg);

/** POST /auth/send-verification - Send email verification link */
router.post('/send-verification', requireAuth, sendVerificationEmail);

/** POST /auth/verify-email - Verify email with token (public, no auth needed) */
router.post('/verify-email', verifyEmail);

/** POST /auth/step-up - Re-verify password before destructive admin actions */
router.post('/step-up', requireAuth, stepUpLimiter, stepUpVerify);

export default router;
