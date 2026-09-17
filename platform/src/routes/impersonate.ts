// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireStepUp } from '@pipeline-builder/api-core';
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
router.post('/requests/:id/decide', requireAuth, decideImpersonationRequest);
router.post('/requests/:id/revoke', requireAuth, revokeImpersonationSession);
/** Redeem IS step-up gated: it mints the session token — the sensitive act. The
 *  step-up done when the request was opened is single-use and long gone after an
 *  approval that may take up to the request TTL. */
router.post('/requests/:id/redeem', requireAuth, requireStepUp, redeemImpersonationRequest);

/** Emergency access. Step-up gated like every token-minting path. */
router.post('/:userId/breakglass', requireAuth, requireStepUp, breakglassImpersonation);

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
router.post('/:userId', requireAuth, requireStepUp, impersonateUser);

export default router;
