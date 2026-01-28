import { Router } from 'express';
import {
  sendInvitation,
  acceptInvitation,
  getInvitation,
  listInvitations,
  revokeInvitation,
  resendInvitation,
} from '../controllers';
import { isAuthenticated, authorize } from '../middleware';

const router = Router();

// Get invitation details by token (public - for preview)
router.get('/:token', getInvitation);

// Accept invitation (authenticated)
router.post('/accept', isAuthenticated, acceptInvitation);

// Send invitation (admin only)
router.post('/send', isAuthenticated, authorize('admin'), sendInvitation);

// List organization invitations (admin only)
router.get('/', isAuthenticated, authorize('admin'), listInvitations);

// Revoke invitation (admin only)
router.delete('/:invitationId', isAuthenticated, authorize('admin'), revokeInvitation);

// Resend invitation (admin only)
router.post('/:invitationId/resend', isAuthenticated, authorize('admin'), resendInvitation);

export default router;
