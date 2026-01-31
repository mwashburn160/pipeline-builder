import { Router } from 'express';
import {
  getMyOrganization,
  getOrganizationById,
  updateOrganization,
  getOrganizationQuotas,
  updateOrganizationQuotas,
  addMember,
  transferOwnership,
  getOrganizationMembers,
  addMemberToOrganization,
  removeMemberFromOrganization,
  updateMemberRole,
  transferOrganizationOwnership,
  deleteOrganization,
} from '../controllers';
import { isAuthenticated, authorize } from '../middleware';

const router = Router();

// Current user's organization
router.get('/', isAuthenticated, getMyOrganization);

// Organization CRUD (system admin can access any org)
router.get('/:id', isAuthenticated, getOrganizationById);
router.put('/:id', isAuthenticated, updateOrganization);
router.delete('/:id', isAuthenticated, deleteOrganization);

// Organization quotas
router.get('/:id/quotas', isAuthenticated, getOrganizationQuotas);
router.put('/:id/quotas', isAuthenticated, updateOrganizationQuotas);

// Organization members (system admin can manage any org)
router.get('/:id/members', isAuthenticated, getOrganizationMembers);
router.post('/:id/members', isAuthenticated, addMemberToOrganization);
router.delete('/:id/members/:userId', isAuthenticated, removeMemberFromOrganization);
router.patch('/:id/members/:userId', isAuthenticated, updateMemberRole);

// Transfer ownership (system admin can transfer any org)
router.patch('/:id/transfer-owner', isAuthenticated, transferOrganizationOwnership);

// Legacy endpoints for regular org admins (their own org only)
router.post('/members', isAuthenticated, authorize('admin'), addMember);
router.patch('/transfer-owner', isAuthenticated, authorize('admin'), transferOwnership);

export default router;
