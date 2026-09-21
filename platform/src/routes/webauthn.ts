// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey (WebAuthn) routes, mounted under `/auth/webauthn` by `routes/auth.ts`
 * (so they inherit the pre-auth `authLimiter`). The two STEP-UP routes live in
 * `routes/auth.ts` instead, under `/auth/step-up/webauthn`, so the whole step-up
 * surface shares one limiter and one URL prefix.
 *
 * Gating rationale:
 *   - ENROLMENT (`register/options`) needs a step-up token. Step-up is
 *     factor-agnostic, so an account with a password re-enters it and an
 *     account without one re-authenticates with its own provider — the first
 *     passkey on a social/SSO account is registered exactly that way.
 *     `register/verify` is NOT step-up gated a second time: the ceremony it
 *     consumes was minted by the gated call, is bound to this user, and is
 *     single-use, so a second token would only cost the user a second prompt.
 *   - REMOVAL takes a fresh step-up of its own — it destroys a credential.
 *   - Everything that mints or destroys a credential also requires an
 *     INTERACTIVE session (`requireInteractiveSession`): never an API key, a
 *     scoped machine token or an impersonated session.
 *   - SIGN-IN is public by construction, like `/auth/login`.
 */

import { audited, requireStepUp } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  listPasskeys,
  loginOptions,
  loginVerify,
  registerOptions,
  registerVerify,
  removePasskey,
  renamePasskey,
} from '../controllers/webauthn.js';
// PLATFORM's `requireAuth`, not api-core's — see the note in `totp.ts`. The
// bootstrap allowlist names `/auth/webauthn/` so a fresh install's admin can
// register a first passkey; api-core's copy refuses the flag outright.
import { requireAuth, requireInteractiveSession } from '../middleware/index.js';
import { extractClientIp } from '../middleware/rate-limit-keys.js';
import { createLimiter } from '../middleware/rate-limiter.js';

const router: Router = Router();

/**
 * Sign-in CHALLENGE limiter, separate from the shared pre-auth `authLimiter`.
 *
 * Browser autofill ("conditional UI") asks for options on every load of the
 * sign-in page, before the person has typed anything — under the 20-per-15-min
 * IP bucket a handful of page loads from one NAT would lock the whole office out
 * of signing in. Minting a challenge reveals nothing and costs nothing, so it
 * gets its own generous per-IP budget. `login/verify` — the request that
 * actually presents a credential — stays on `authLimiter`.
 */
const loginOptionsLimiter = createLimiter({
  name: 'webauthn-login-options',
  windowMs: 60_000,
  max: 60,
  keyGenerator: extractClientIp,
  message: 'Too many passkey sign-in attempts. Please wait a minute and try again.',
});

/** POST /auth/webauthn/register/options - Begin enrolling a passkey */
router.post('/register/options', requireAuth, requireInteractiveSession, requireStepUp, registerOptions);

/** POST /auth/webauthn/register/verify - Store the enrolled passkey */
router.post(
  '/register/verify',
  requireAuth,
  requireInteractiveSession,
  audited('user.passkey.register'),
  registerVerify,
);

/** GET /auth/webauthn/credentials - The caller's own passkeys */
router.get('/credentials', requireAuth, listPasskeys);

/** PATCH /auth/webauthn/credentials/:id - Relabel a passkey */
router.patch(
  '/credentials/:id',
  requireAuth,
  requireInteractiveSession,
  audited('user.passkey.rename'),
  renamePasskey,
);

/** DELETE /auth/webauthn/credentials/:id - Revoke a passkey */
router.delete(
  '/credentials/:id',
  requireAuth,
  requireInteractiveSession,
  requireStepUp,
  audited('user.passkey.remove'),
  removePasskey,
);

/** POST /auth/webauthn/login/options - Challenge for a discoverable credential */
router.post('/login/options', loginOptionsLimiter, loginOptions);

/** POST /auth/webauthn/login/verify - Sign in with a passkey */
router.post('/login/verify', audited('user.login', 'user.login.failed'), loginVerify);

export default router;
