// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey (WebAuthn) routes, mounted under `/auth/webauthn` by `routes/auth.ts`.
 * Each route names its own bucket (middleware/auth-limiters.ts): sign-in on
 * `signInLimiter`, the autofill challenge on `authDiscoveryLimiter`, enrolment
 * and management on the per-user `accountSecurityLimiter`, and the caller's own
 * passkey list on nothing but the root limiter. The two STEP-UP routes live in
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
import { accountSecurityLimiter, authDiscoveryLimiter, signInLimiter } from '../middleware/auth-limiters.js';
// PLATFORM's `requireAuth`, not api-core's — see the note in `totp.ts`. The
// bootstrap allowlist names `/auth/webauthn/` so a fresh install's admin can
// register a first passkey; api-core's copy refuses the flag outright.
import { requireAuth, requireInteractiveSession } from '../middleware/index.js';

const router: Router = Router();

/** POST /auth/webauthn/register/options - Begin enrolling a passkey */
router.post('/register/options', requireAuth, accountSecurityLimiter, requireInteractiveSession, requireStepUp, registerOptions);

/** POST /auth/webauthn/register/verify - Store the enrolled passkey */
router.post(
  '/register/verify',
  requireAuth,
  accountSecurityLimiter,
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
  accountSecurityLimiter,
  requireInteractiveSession,
  audited('user.passkey.rename'),
  renamePasskey,
);

/** DELETE /auth/webauthn/credentials/:id - Revoke a passkey */
router.delete(
  '/credentials/:id',
  requireAuth,
  accountSecurityLimiter,
  requireInteractiveSession,
  requireStepUp,
  audited('user.passkey.remove'),
  removePasskey,
);

/**
 * POST /auth/webauthn/login/options - Challenge for a discoverable credential.
 *
 * Browser autofill ("conditional UI") asks for this on every load of the
 * sign-in page, before the person has typed anything — so it must not spend the
 * sign-in budget. Minting a challenge reveals nothing, names no user and
 * authenticates nobody; it gets the generous per-IP discovery bucket.
 */
router.post('/login/options', authDiscoveryLimiter, loginOptions);

/** POST /auth/webauthn/login/verify - Sign in with a passkey */
router.post('/login/verify', signInLimiter, audited('user.login', 'user.login.failed'), loginVerify);

export default router;
