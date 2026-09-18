// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { audited, verifyServicePrincipal } from '@pipeline-builder/api-core';
import { Router } from 'express';
import totpRoutes from './totp.js';
import webauthnRoutes from './webauthn.js';
import { login, logout, register, refresh, switchOrg, sendVerificationEmail, verifyEmail, markEmailVerified, completeOnboarding, getDomainOrgs, joinDomainOrg } from '../controllers/index.js';
import { completeStepUpReauth, startStepUpReauth } from '../controllers/step-up-reauth.js';
import { stepUpVerify } from '../controllers/step-up.js';
import { exchangeToken, revokeKey, rotateKey } from '../controllers/token-exchange.js';
import { stepUpVerifyTotp, verifyMfaLogin } from '../controllers/totp.js';
import { stepUpOptions, stepUpVerifyWebAuthn } from '../controllers/webauthn.js';
import { requireAuth, isValidRefreshToken, requireClientType, stepUpLimiter } from '../middleware/index.js';
import { extractClientIp } from '../middleware/rate-limit-keys.js';
import { createLimiter, userOrIpKey } from '../middleware/rate-limiter.js';

const router: Router = Router();

/** POST /auth/register - Create a new user account */
router.post('/register', audited('user.register'), register);

/** POST /auth/login - Authenticate and receive tokens */
router.post('/login', audited('user.login', 'user.login.failed'), login);

/**
 * Two limiters guard the access-key exchange, because neither can do both jobs:
 *
 *  - PER KEY: a legitimate holder exchanges about once per token lifetime per
 *    process, so 60/min is generous while still bounding one leaked key.
 *  - PER IP: a guessing client presents a DIFFERENT key each time, so the
 *    per-key bucket never fills — the IP bucket is what stops enumeration. Sized
 *    well above the per-key limit (a service pod exchanges for many keys from
 *    one IP) and skipped entirely for a verified internal service principal,
 *    which is what api-core's exchange client presents.
 */
const exchangeKeyLimiter = createLimiter({
  name: 'token-exchange-key',
  windowMs: 60_000,
  max: 60,
  // Key on the HASH of the presented credential — never the credential itself,
  // which would put a live secret into the shared Redis store's key space.
  keyGenerator: (req) => (typeof req.body?.key === 'string' && req.body.key
    ? `k:${createHash('sha256').update(req.body.key).digest('hex')}`
    : extractClientIp(req)),
  message: 'Too many exchanges for this access key. Please wait a minute and try again.',
});

const exchangeIpLimiter = createLimiter({
  name: 'token-exchange-ip',
  windowMs: 60_000,
  max: 300,
  keyGenerator: extractClientIp,
  skip: (req) => verifyServicePrincipal(req),
  message: 'Too many access-key exchanges. Please wait a minute and try again.',
});

/** POST /auth/token/exchange - Trade an opaque access key for a 5-minute JWT.
 *  Pre-auth by construction: the key IS the credential. Both outcomes audited. */
router.post(
  '/token/exchange',
  exchangeIpLimiter,
  exchangeKeyLimiter,
  audited('user.key.exchange', 'user.key.exchange.failed'),
  exchangeToken,
);

/**
 * Self-rotation (#N2) — an unattended machine replacing its own credential.
 *
 * Mounted next to the exchange and behind the SAME two limiters, because the
 * threat model is identical: the key is the credential, so the endpoint must be
 * bounded per key (one leaked key) and per IP (enumeration). Rotation is far
 * rarer than exchange — daily, not every five minutes — so the shared budget is
 * never the binding constraint for a legitimate rotator.
 *
 * POST /auth/key/rotate - Mint a SIBLING key on the presented key's account.
 *   The presented key stays LIVE, so a failure anywhere leaves a working
 *   credential; the caller retires it afterwards with /auth/key/revoke.
 */
router.post(
  '/key/rotate',
  exchangeIpLimiter,
  exchangeKeyLimiter,
  audited('org.service-account.key.rotate', 'org.service-account.key.rotate.failed'),
  rotateKey,
);

/** POST /auth/key/revoke - Retire a SIBLING key with the live key that replaced
 *  it. Revoking the PRESENTED key is refused; revoking an already-revoked one is
 *  idempotent success (a retrying rotator must not see a false failure). */
router.post(
  '/key/revoke',
  exchangeIpLimiter,
  exchangeKeyLimiter,
  audited('org.service-account.key.revoke', 'org.service-account.key.rotate.failed'),
  revokeKey,
);

/**
 * POST /auth/refresh - Exchange refresh token for new access token.
 * `requireClientType` is the CSRF gate: the browser's token is a cookie, so the
 * request must carry a header no cross-site page can set.
 */
router.post('/refresh', requireClientType, isValidRefreshToken, refresh);

/** POST /auth/logout - Invalidate current session (and clear the refresh cookie) */
router.post('/logout', requireClientType, requireAuth, audited('user.logout'), logout);

/** POST /auth/switch-org - Switch active organization and re-issue tokens */
router.post('/switch-org', requireAuth, audited('org.switch'), switchOrg);

/** POST /auth/onboarding/complete - Finish first-run onboarding (name org + plan) */
router.post('/onboarding/complete', requireAuth, audited('user.onboarding.complete'), completeOnboarding);

/** POST /auth/send-verification - Send email verification link */
router.post('/send-verification', requireAuth, sendVerificationEmail);

/** POST /auth/verify-email - Verify email with token (public, no auth needed) */
router.post('/verify-email', audited('user.email.verified'), verifyEmail);

/** POST /auth/mark-email-verified - Superadmin self-verify (no token). */
router.post('/mark-email-verified', requireAuth, audited('user.email.verified'), markEmailVerified);

/** POST /auth/step-up - Re-verify password before destructive admin actions */
router.post('/step-up', requireAuth, stepUpLimiter, audited('user.step-up', 'user.login.failed'), stepUpVerify);

/** POST /auth/step-up/reauth - Start a re-auth with the caller's own sign-in
 *  provider (the step-up path for accounts that have no password). */
router.post('/step-up/reauth', requireAuth, stepUpLimiter, startStepUpReauth);

/** POST /auth/step-up/reauth/callback - Verify that re-auth and issue the step-up token */
router.post('/step-up/reauth/callback', requireAuth, stepUpLimiter, audited('user.step-up', 'user.login.failed'), completeStepUpReauth);

/**
 * Passkey step-up — the third factor-agnostic way to earn the SAME step-up
 * token. Mounted here (not in routes/webauthn.ts) so the whole /auth/step-up
 * surface shares one per-user budget: a brute-force allowance that reset per
 * factor would just be the loosest of them.
 */
router.post('/step-up/webauthn/options', requireAuth, stepUpLimiter, stepUpOptions);
router.post('/step-up/webauthn/verify', requireAuth, stepUpLimiter, audited('user.step-up', 'user.login.failed'), stepUpVerifyWebAuthn);

/**
 * Authenticator-app step-up — the fourth factor-agnostic way to earn the SAME
 * token, and the one a person on a device with no passkey and no linked provider
 * can always reach. On the shared per-user budget for the same reason as the
 * others; the service adds a per-account lockout on top, because a 6-digit code
 * is small enough that the request limiter alone is not the real bound.
 */
router.post('/step-up/totp', requireAuth, stepUpLimiter, audited('user.step-up', 'user.login.failed'), stepUpVerifyTotp);

/**
 * Second leg of a password sign-in for an account with an authenticator app.
 * PRE-AUTH by construction, exactly like `/auth/login`: the caller holds a
 * challenge handle, not a session.
 *
 * Its own limiter rather than `authLimiter`: the first leg already spent part of
 * that IP budget, and a legitimate person may fat-finger a 6-digit code once or
 * twice. Keyed per CHALLENGE (falling back to the IP) so one person retrying
 * can't lock out everyone behind the same NAT — and the per-account TOTP lockout
 * is what actually bounds guessing.
 */
const mfaVerifyLimiter = createLimiter({
  name: 'mfa-verify',
  windowMs: 60_000,
  max: 10,
  keyGenerator: (req) => (typeof req.body?.challengeId === 'string' && req.body.challengeId
    ? `c:${createHash('sha256').update(req.body.challengeId).digest('hex')}`
    : extractClientIp(req)),
  message: 'Too many verification attempts. Please wait a minute and try again.',
});

router.post('/mfa/verify', mfaVerifyLimiter, audited('user.login', 'user.login.failed'), verifyMfaLogin);

/** Passkey registration, management and sign-in (/auth/webauthn/*). */
router.use('/webauthn', webauthnRoutes);

/** Authenticator-app enrolment and management (/auth/totp/*). */
router.use('/totp', totpRoutes);

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
router.post('/onboarding/join', requireAuth, domainJoinLimiter, audited('org.join.auto', 'org.join.request'), joinDomainOrg);

export default router;
