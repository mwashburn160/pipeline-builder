// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticator-app (TOTP) routes, mounted under `/auth/totp` by
 * `routes/auth.ts` (so they inherit the pre-auth `authLimiter`). The STEP-UP
 * route lives in `routes/auth.ts` instead, under `/auth/step-up/totp`, so the
 * whole step-up surface shares one limiter and one URL prefix — and the sign-in
 * exchange lives there too, under `/auth/mfa/verify`, because it is a sign-in
 * route rather than a management one.
 *
 * Gating rationale (the same as passkeys, for the same reasons):
 *   - ENROLMENT needs a step-up token. Step-up is factor-agnostic, so an account
 *     with a password re-enters it and an account without one re-authenticates
 *     with its own provider or a passkey.
 *     `activate` is NOT step-up gated a second time: it confirms the pending
 *     secret the gated call minted, and is useless without a code from the
 *     authenticator that secret reached.
 *   - REMOVAL takes a fresh step-up — it destroys the factor. (Recovery codes
 *     belong to the account, not to this factor: `/auth/recovery-codes`.)
 *   - Everything that mints or destroys factor material also requires an
 *     INTERACTIVE session (`requireInteractiveSession`): never an API key, a
 *     scoped machine token or an impersonated session, read-only or not.
 *   - STATUS is a plain read of the caller's own account.
 */

import { audited, requireAuth, requireStepUp } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  activateTotp,
  disableTotp,
  enrolTotp,
  totpStatus,
} from '../controllers/totp.js';
import { requireInteractiveSession } from '../middleware/index.js';

const router: Router = Router();

/** GET /auth/totp/status - Whether the caller has an authenticator app */
router.get('/status', requireAuth, totpStatus);

/** POST /auth/totp/enrol - Mint a secret + otpauth:// URI (shown once) */
router.post(
  '/enrol',
  requireAuth,
  requireInteractiveSession,
  requireStepUp,
  audited('user.totp.enrol'),
  enrolTotp,
);

/** POST /auth/totp/activate - Confirm the enrolment with a code */
router.post(
  '/activate',
  requireAuth,
  requireInteractiveSession,
  audited('user.totp.enrol', 'user.login.failed'),
  activateTotp,
);

/** DELETE /auth/totp - Turn the authenticator off */
router.delete(
  '/',
  requireAuth,
  requireInteractiveSession,
  requireStepUp,
  audited('user.totp.disable'),
  disableTotp,
);

export default router;
