// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * MFA recovery-code routes, mounted under `/auth/recovery-codes` by
 * `routes/auth.ts`. Regeneration is on the per-user `accountSecurityLimiter`
 * (middleware/auth-limiters.ts); the status read on the root limiter only.
 *
 * The codes back up the ACCOUNT's second factor — a passkey or an
 * authenticator app — so they are managed here rather than under either
 * factor's routes. Regenerating invalidates every code already written down,
 * so it takes a fresh step-up and a session the person opened themselves,
 * exactly like enrolling or removing a factor. Status is a plain read.
 */

import { audited, requireStepUp } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { recoveryCodeStatus, regenerateRecoveryCodes } from '../controllers/recovery-codes.js';
// PLATFORM's `requireAuth`, like every other platform route — so the
// bootstrap allowlist stays the single place that decides what an
// enrolment-pending session may reach. Recovery codes are NOT on that list
// (they follow a first factor, by which point the exception has closed), so
// this changes no answer today; it keeps the decision in one place.
import { accountSecurityLimiter } from '../middleware/auth-limiters.js';
import { requireAuth, requireInteractiveSession } from '../middleware/index.js';

const router: Router = Router();

/** GET /auth/recovery-codes - How many recovery codes the caller has left */
router.get('/', requireAuth, recoveryCodeStatus);

/** POST /auth/recovery-codes - Replace the recovery-code set (shown once) */
router.post(
  '/',
  requireAuth,
  accountSecurityLimiter,
  requireInteractiveSession,
  requireStepUp,
  audited('user.mfa.recovery_regenerate'),
  regenerateRecoveryCodes,
);

export default router;
