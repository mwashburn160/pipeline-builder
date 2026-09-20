// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, requireOrgAdminAssurance, requirePermission } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  sendInvitation,
  acceptInvitation,
  acceptInvitationViaOAuth,
  getInvitation,
  listInvitations,
  revokeInvitation,
  resendInvitation,
} from '../controllers/index.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router();

/** The org's "administrative actions require MFA" policy. Invitations are
 *  legitimately sent by automation (onboarding scripts), so machine credentials
 *  pass; a person needs `aal: 2` while the policy is on. */
const adminMfa = requireOrgAdminAssurance({ machines: 'allow' });

/*
 * Public Endpoints
 */

/** GET /invitation/:token - Get invitation details by token (public, for preview) */
router.get('/:token', getInvitation);

/** POST /invitation/accept-oauth - Accept invitation via OAuth (public, creates user if needed) */
router.post('/accept-oauth', audited('invitation.accept'), acceptInvitationViaOAuth);

/*
 * Authenticated User Endpoints
 */

/** POST /invitation/accept - Accept invitation (authenticated user) */
router.post('/accept', requireAuth, audited('invitation.accept'), acceptInvitation);

/*
 * Admin-Only Endpoints
 */

/** POST /invitation/send - Send new invitation (org admin only) */
router.post('/send', requireAuth, requirePermission('invitations:manage'), adminMfa, audited('invitation.send'), sendInvitation);

/** GET /invitation - List organization's invitations (org admin only) */
router.get('/', requireAuth, requirePermission('invitations:manage'), listInvitations);

/** DELETE /invitation/:invitationId - Revoke pending invitation (org admin only) */
router.delete('/:invitationId', requireAuth, requirePermission('invitations:manage'), adminMfa, audited('invitation.revoke'), revokeInvitation);

/** POST /invitation/:invitationId/resend - Resend invitation email (org admin only) */
router.post('/:invitationId/resend', requireAuth, requirePermission('invitations:manage'), adminMfa, audited('invitation.resend'), resendInvitation);

export default router;
