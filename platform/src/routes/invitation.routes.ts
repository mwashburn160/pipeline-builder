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

// Get invitation details by token (public - for preview)
router.get('/:token', getInvitation);

// Accept invitation (authenticated - supports both email and OAuth)
router.post('/accept', isAuthenticated, acceptInvitation);

// Accept invitation via OAuth (public - creates user if needed)
router.post('/accept-oauth', acceptInvitationViaOAuth);

// Send invitation (admin only)
router.post('/send', isAuthenticated, authorize('admin'), sendInvitation);

// List organization invitations (admin only)
router.get('/', isAuthenticated, authorize('admin'), listInvitations);

// Revoke invitation (admin only)
router.delete('/:invitationId', isAuthenticated, authorize('admin'), revokeInvitation);

// Resend invitation (admin only)
router.post('/:invitationId/resend', isAuthenticated, authorize('admin'), resendInvitation);

export default router;
