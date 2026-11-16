// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The buckets that guard the `/auth*` surface, attached ROUTE BY ROUTE.
 *
 * Until this module the strict per-IP limiter was mounted on the whole `/auth`
 * tree (`app.use('/auth', limiters.auth, …)`) and every route that should not
 * spend it was carved out with a `skip` predicate. That was the wrong default:
 * each new route under `/auth` — a page-load read, a session refresh, a factor
 * listing — silently joined the 20-per-15-minute brute-force budget until
 * someone was locked out by it, and five separate fixes (sign-out, the Security
 * page reads, refresh/switch-org, the passkey challenge, the OAuth provider
 * list) each added one more exception. The tree mount also counted twice: it
 * matched `/auth/oauth/*` and `/auth/sso/*` AND those prefixes had their own
 * mount of the same limiter, so every OAuth/SSO request spent two attempts.
 *
 * Now a route spends a bucket only if it names one. What each guards:
 *
 *  - `signInLimiter` — per IP, FAILED attempts only. Every route that presents
 *    a credential or a single-use secret (password, passkey assertion, OAuth/
 *    SSO code or assertion, sign-in challenge handle, email-verification token,
 *    access key). It is what stops guessing from one address, and guessing is
 *    measured in failures: a person who signs in correctly never spends it.
 *    Keeps the `auth` store namespace, `AUTH_LIMITER_*` config and message.
 *  - `registerLimiter` — per IP, EVERY attempt. Account creation, where a
 *    success is the abuse (mass sign-ups), so successes must count.
 *  - `authDiscoveryLimiter` — per IP, generous. Pre-auth reads and flow starts
 *    that reveal nothing and authenticate nobody but which a sign-in page makes
 *    on its own (the provider list on every load, the passkey autofill
 *    challenge, SSO discovery while typing, building an IdP redirect).
 *  - `accountSecurityLimiter` — per SIGNED-IN USER. Authenticated writes to
 *    one's own sign-in factors and account (enrol/rename/remove a passkey or
 *    authenticator, regenerate recovery codes, send a verification email). They
 *    already sit behind `requireAuth` and mostly `requireStepUp`; this bounds
 *    a runaway client per person, and — unlike the per-IP bucket they used to
 *    share — a fresh install's admin can never be locked out of enrolling the
 *    factor that ends their enrolment-only session by failed sign-ins from the
 *    same address.
 *
 * Everything else under `/auth` (refresh, sign-out, switch-org, self-reads)
 * is bounded by the root `generalLimiter` like any other route, plus whatever
 * dedicated limiter the route declares (step-up, MFA verify, token exchange,
 * password reset, device authorization).
 */

import { verifyServicePrincipal } from '@pipeline-builder/api-core';
import type { RequestHandler } from 'express';

import { extractClientIp } from './rate-limit-keys.js';
import { createLimiter, userOrIpKey } from './rate-limiter.js';
import { config } from '../config/index.js';

/** Failed credential presentations per IP — see the module comment. */
export const signInLimiter: RequestHandler = createLimiter({
  name: 'auth',
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  keyGenerator: extractClientIp,
  skipSuccessfulRequests: true,
  // A verified internal service (image-registry relaying `docker login`) sends
  // every user's attempt from one pod IP; counting those in one IP bucket would
  // let one user's failures lock everyone out. That service limits per client
  // and username itself (image-registry token-rate-limiter).
  skip: (req) => verifyServicePrincipal(req),
  message: 'Too many authentication attempts. Please try again later.',
});

/** Account creation per IP, successes included — see the module comment. */
export const registerLimiter: RequestHandler = createLimiter({
  name: 'auth-register',
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  keyGenerator: extractClientIp,
  message: 'Too many sign-up attempts from your network. Please try again later.',
});

/** Pre-auth reads and flow starts per IP — see the module comment. */
export const authDiscoveryLimiter: RequestHandler = createLimiter({
  name: 'auth-discovery',
  windowMs: config.rateLimit.authDiscovery.windowMs,
  max: config.rateLimit.authDiscovery.max,
  keyGenerator: extractClientIp,
  message: 'Too many sign-in requests from your network. Please wait a minute and try again.',
});

/**
 * Authenticated account-security writes per user — see the module comment.
 * Must be mounted AFTER `requireAuth` so `userOrIpKey` sees the user.
 */
export const accountSecurityLimiter: RequestHandler = createLimiter({
  name: 'account-security',
  windowMs: config.rateLimit.accountSecurity.windowMs,
  max: config.rateLimit.accountSecurity.max,
  keyGenerator: userOrIpKey,
  message: 'Too many account security changes. Please wait a few minutes and try again.',
});
