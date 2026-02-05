/**
 * @module routes/invitation
 * @description Organization invitation management routes.
 * Supports email-based and OAuth-based invitation flows.
 */

import { Router } from 'express';
import {
  sendInvitation,
  acceptInvitation,
  acceptInvitationViaOAuth,
  getInvitation,
  listInvitations,
  revokeInvitation,
  resendInvitation,
} from '../controllers';
import { isAuthenticated, authorize } from '../middleware';

const router = Router();

/*
 * Public Endpoints
 */

/** GET /invitation/:token - Get invitation details by token (public, for preview) */
router.get('/:token', getInvitation);

/** POST /invitation/accept-oauth - Accept invitation via OAuth (public, creates user if needed) */
router.post('/accept-oauth', acceptInvitationViaOAuth);

/*
 * Authenticated User Endpoints
 */

/** POST /invitation/accept - Accept invitation (authenticated user) */
router.post('/accept', isAuthenticated, acceptInvitation);

/*
 * Admin-Only Endpoints
 */

/** POST /invitation/send - Send new invitation (org admin only) */
router.post('/send', isAuthenticated, authorize('admin'), sendInvitation);

/** GET /invitation - List organization's invitations (org admin only) */
router.get('/', isAuthenticated, authorize('admin'), listInvitations);

/** DELETE /invitation/:invitationId - Revoke pending invitation (org admin only) */
router.delete('/:invitationId', isAuthenticated, authorize('admin'), revokeInvitation);

/** POST /invitation/:invitationId/resend - Resend invitation email (org admin only) */
router.post('/:invitationId/resend', isAuthenticated, authorize('admin'), resendInvitation);

export default router;
