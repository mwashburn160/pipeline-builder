// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { login, logout, register, refresh, switchOrg, sendVerificationEmail, verifyEmail, markEmailVerified, completeOnboarding, getDomainOrgs, joinDomainOrg } from '../controllers/index.js';
import { stepUpVerify } from '../controllers/step-up.js';
import { requireAuth, isValidRefreshToken } from '../middleware/index.js';
import { createLimiter, userOrIpKey } from '../middleware/rate-limiter.js';

const router: Router = Router();

/**
 * Tight per-user limiter for /auth/step-up.
 *
 * The endpoint accepts raw passwords from an already-authenticated session. The
 * global `authLimiter` (20 req / 15 min, IP-keyed) is too loose for brute-force
 * protection here — a session pivoter sharing an IP with legitimate users could
 * burn the budget. Per-user keying (requireAuth runs first) with a much tighter
 * window: 5 attempts / minute, allowing for fat-fingers + a retry on a transient
 * error. The StepUpModal surfaces the 429 message verbatim.
 */
const stepUpLimiter = createLimiter({
  name: 'step-up',
  windowMs: 60_000,
  max: 5,
  keyGenerator: userOrIpKey,
  message: 'Too many step-up attempts. Please wait a minute and try again.',
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

/** POST /auth/onboarding/complete - Finish first-run onboarding (name org + plan) */
router.post('/onboarding/complete', requireAuth, completeOnboarding);

/** POST /auth/send-verification - Send email verification link */
router.post('/send-verification', requireAuth, sendVerificationEmail);

/** POST /auth/verify-email - Verify email with token (public, no auth needed) */
router.post('/verify-email', verifyEmail);

/** POST /auth/mark-email-verified - Superadmin self-verify (no token). */
router.post('/mark-email-verified', requireAuth, markEmailVerified);

/** POST /auth/step-up - Re-verify password before destructive admin actions */
router.post('/step-up', requireAuth, stepUpLimiter, stepUpVerify);

/**
 * Per-user limiter for the domain-based join endpoints. Discovery + join are
 * authenticated but still worth bounding: `join` writes to an org's admin queue
 * (request spam) and both are cheap enumeration probes if abused. Keyed per-user
 * (requireAuth runs first), tighter than the shared IP `authLimiter`.
 */
const domainJoinLimiter = createLimiter({
  name: 'domain-join',
  windowMs: 60_000,
  max: 15,
  keyGenerator: userOrIpKey,
  message: 'Too many requests. Please wait a minute and try again.',
});

/** GET /auth/onboarding/domain-orgs - Orgs the user could join by verified email domain */
router.get('/onboarding/domain-orgs', requireAuth, domainJoinLimiter, getDomainOrgs);

/** POST /auth/onboarding/join - Auto-join or request to join a domain-discovered org */
router.post('/onboarding/join', requireAuth, domainJoinLimiter, joinDomainOrg);

export default router;
