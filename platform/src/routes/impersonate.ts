// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, requireAssurance, requireStepUp, STRONG_STEP_UP_METHODS } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  breakglassImpersonation,
  decideImpersonationRequest,
  impersonateUser,
  listImpersonationRequests,
  redeemImpersonationRequest,
  revokeImpersonationSession,
} from '../controllers/impersonate.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router({ mergeParams: true });

/**
 * ASSURANCE (#8). Every route below that MINTS an impersonation session demands
 * two things that a stolen browser session cannot supply on its own:
 *
 *   - `requireAssurance({ minAssurance: 2 })` — the operator's whole SESSION must
 *     be MFA-grade. A weaker one gets 401 `MFA_REQUIRED`; it can never be raised
 *     by refreshing, so the operator signs in again with a passkey or an
 *     authenticator code.
 *   - `requireStepUp({ methods: STRONG_STEP_UP_METHODS })` — and the action must
 *     be confirmed by a SECOND factor specifically. Re-typing the password the
 *     session was already opened with proves nothing an attacker holding that
 *     session doesn't already have.
 *
 * Deciding and revoking stay as they were: they only ever remove access, and the
 * decider is answering a question about their own account.
 */

/**
 * Decide a pending challenge, and end a live session early.
 *
 * Declared BEFORE `/:userId` — Express matches in order, so `/requests/...`
 * would otherwise be swallowed by the `:userId` parameter and treated as an
 * impersonation of a user literally named "requests".
 *
 * No step-up on either: the decider is answering a question about their OWN
 * account, and revoking only ever REMOVES access — gating the off-switch behind
 * a password prompt would make it harder to stop a session than to allow one.
 */
/** What the caller can act on. No step-up: listing grants nothing, and the
 *  impersonated user — usually not an admin — must be able to find a request to
 *  view their own account. Filtered server-side by the decide/revoke rules. */
router.get('/requests', requireAuth, listImpersonationRequests);
router.post('/requests/:id/decide', requireAuth, audited('admin.impersonate.approve', 'admin.impersonate.deny'), decideImpersonationRequest);
router.post('/requests/:id/revoke', requireAuth, audited('admin.impersonate.revoke'), revokeImpersonationSession);
/** Redeem IS step-up gated: it mints the session token — the sensitive act. The
 *  step-up done when the request was opened is single-use and long gone after an
 *  approval that may take up to the request TTL. */
router.post('/requests/:id/redeem', requireAuth, requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.impersonate.start'), redeemImpersonationRequest);

/** Emergency access. Step-up gated like every token-minting path. */
router.post('/:userId/breakglass', requireAuth, requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.impersonate.breakglass', 'admin.impersonate.start'), breakglassImpersonation);

/**
 * POST /admin/impersonate/:userId — start a read-only impersonation session of
 * the target user.
 *
 * Two callers qualify: a platform sysadmin (any target), or an admin of an org
 * that is a strict ancestor of the target's org (their own subtree only). That
 * depends on BOTH parties — specifically on the org the session pins to — so it
 * cannot be a route-level middleware and is resolved in the controller by
 * `resolveImpersonationAuthority`.
 *
 * Step-up applies to EVERY caller. A parent admin's session is no less
 * sensitive than a sysadmin's, and an admin session is the likelier of the two
 * to be stolen.
 */
router.post('/:userId', requireAuth, requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.impersonate.request', 'admin.impersonate.start'), impersonateUser);

export default router;
