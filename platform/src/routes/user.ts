// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, requireStepUp } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  changePassword,
  createAccessKey,
  deleteUser,
  generateToken,
  getPreferences,
  getUser,
  listAccessKeys,
  listSessions,
  listTokenHistory,
  listUserOrganizations,
  revokeAllTokens,
  revokeAccessKey,
  revokeSession,
  updatePreferences,
  updateUser,
} from '../controllers/index.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router();

/** GET /user/profile - Get current user's profile */
router.get('/profile', requireAuth, getUser);

/** PATCH /user/profile - Update current user's profile */
router.patch('/profile', requireAuth, audited('user.profile.update'), updateUser);

/** DELETE /user/account - Delete current user's account.
 *  Step-up gated — a stolen session shouldn't be able to tombstone the account. */
router.delete('/account', requireAuth, requireStepUp, audited('user.delete'), deleteUser);

/** POST /user/change-password - Change current user's password.
 *  Step-up gated — defense-in-depth. The handler still verifies
 *  `currentPassword`, but step-up makes session-pivot attacks fail before
 *  the password-comparison side channel can be probed. */
router.post('/change-password', requireAuth, requireStepUp, audited('user.password.change'), changePassword);

/** GET /user/organizations - List all organizations the user belongs to */
router.get('/organizations', requireAuth, listUserOrganizations);

/** POST /user/generate-token - Mint a stored MACHINE credential (optionally
 *  longer-lived or scoped) in its own machine session; from a machine token it
 *  renews that session in place. NOT step-up gated: the unattended token-renewal
 *  Lambda and `pipeline-manager infra store-token` call it with no password. A
 *  scoped caller can only re-mint its own scope. */
router.post('/generate-token', requireAuth, audited('user.token.create'), generateToken);

/** GET /user/tokens - List the user's recent token-issuance history (with computed status). */
router.get('/tokens', requireAuth, listTokenHistory);

/** Sessions and devices — the caller's own refresh-session slots: signed-in
 *  devices plus the stored machine credentials generate-token opened.
 *  Revoking one is step-up gated for the same reason as revoke-all: a stolen
 *  session must not be able to sign the legitimate user's devices out (or stop
 *  a production credential from renewing). The current session can't revoke
 *  itself — that's POST /auth/logout. */
router.get('/sessions', requireAuth, listSessions);
router.delete('/sessions/:id', requireAuth, requireStepUp, audited('user.session.revoke'), revokeSession);

/** Access keys — named, individually-revocable opaque API credentials
 *  (`pb_pat_…`), shown once at creation and stored only as a hash.
 *  Creation is step-up gated: minting a long-lived bearer credential is at least
 *  as sensitive as change-password / revoke-all, and step-up also blocks
 *  key-chaining (a key can't produce the step-up token creating a new one needs). */
router.post('/keys', requireAuth, requireStepUp, audited('user.key.create'), createAccessKey);
router.get('/keys', requireAuth, listAccessKeys);
router.delete('/keys/:id', requireAuth, audited('user.key.revoke'), revokeAccessKey);

/** Personalization — server-persisted favorites/recents for the active org. */
router.get('/preferences', requireAuth, getPreferences);
router.put('/preferences', requireAuth, updatePreferences);

/** POST /user/tokens/revoke-all - Sign out everywhere by bumping tokenVersion.
 *  Step-up gated — a stolen session shouldn't be able to forcibly sign out
 *  legitimate sessions (effectively locking the user out for the refresh
 *  window). */
router.post('/tokens/revoke-all', requireAuth, requireStepUp, audited('user.tokens.revoke-all'), revokeAllTokens);

export default router;
