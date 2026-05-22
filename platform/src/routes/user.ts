// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import {
  changePassword,
  deleteUser,
  generateToken,
  getUser,
  listTokenHistory,
  listUserOrganizations,
  revokeAllTokens,
  updateUser,
} from '../controllers';
import { requireAuth, requireStepUp } from '../middleware';

const router = Router();

/** GET /user/profile - Get current user's profile */
router.get('/profile', requireAuth, getUser);

/** PATCH /user/profile - Update current user's profile */
router.patch('/profile', requireAuth, updateUser);

/** DELETE /user/account - Delete current user's account.
 *  Step-up gated — a stolen session shouldn't be able to tombstone the account. */
router.delete('/account', requireAuth, requireStepUp, deleteUser);

/** POST /user/change-password - Change current user's password */
router.post('/change-password', requireAuth, changePassword);

/** GET /user/organizations - List all organizations the user belongs to */
router.get('/organizations', requireAuth, listUserOrganizations);

/** POST /user/generate-token - Generate API token for current user */
router.post('/generate-token', requireAuth, generateToken);

/** GET /user/tokens - List the user's recent token-issuance history (with computed status). */
router.get('/tokens', requireAuth, listTokenHistory);

/** POST /user/tokens/revoke-all - Sign out everywhere by bumping tokenVersion.
 *  Step-up gated — a stolen session shouldn't be able to forcibly sign out
 *  legitimate sessions (effectively locking the user out for the refresh
 *  window). */
router.post('/tokens/revoke-all', requireAuth, requireStepUp, revokeAllTokens);

export default router;
