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
import { isAuthenticated, authorize, adminRateLimiters, apiRateLimiters } from '../middleware';

const router = Router();

// Get invitation details by token (public - for preview)
router.get('/:token', apiRateLimiters.read, getInvitation);

// Accept invitation (authenticated - supports both email and OAuth)
router.post('/accept', isAuthenticated, apiRateLimiters.write, acceptInvitation);

// Accept invitation via OAuth (public - creates user if needed)
router.post('/accept-oauth', apiRateLimiters.write, acceptInvitationViaOAuth);

// Send invitation (admin only)
router.post('/send', isAuthenticated, authorize('admin'), adminRateLimiters.invitations, sendInvitation);

// List organization invitations (admin only)
router.get('/', isAuthenticated, authorize('admin'), apiRateLimiters.read, listInvitations);

// Revoke invitation (admin only)
router.delete('/:invitationId', isAuthenticated, authorize('admin'), adminRateLimiters.invitations, revokeInvitation);

// Resend invitation (admin only)
router.post('/:invitationId/resend', isAuthenticated, authorize('admin'), adminRateLimiters.invitations, resendInvitation);

export default router;
