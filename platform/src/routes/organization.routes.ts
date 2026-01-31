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
import { isAuthenticated, authorize, adminRateLimiters, apiRateLimiters } from '../middleware';

const router = Router();

// Current user's organization
router.get('/', isAuthenticated, apiRateLimiters.read, getMyOrganization);

// Organization CRUD (system admin can access any org)
router.get('/:id', isAuthenticated, apiRateLimiters.read, getOrganizationById);
router.put('/:id', isAuthenticated, adminRateLimiters.orgManagement, updateOrganization);
router.delete('/:id', isAuthenticated, adminRateLimiters.orgManagement, deleteOrganization);

// Organization quotas
router.get('/:id/quotas', isAuthenticated, apiRateLimiters.read, getOrganizationQuotas);
router.put('/:id/quotas', isAuthenticated, adminRateLimiters.orgManagement, updateOrganizationQuotas);

// Organization members (system admin can manage any org)
router.get('/:id/members', isAuthenticated, apiRateLimiters.read, getOrganizationMembers);
router.post('/:id/members', isAuthenticated, adminRateLimiters.orgManagement, addMemberToOrganization);
router.delete('/:id/members/:userId', isAuthenticated, adminRateLimiters.orgManagement, removeMemberFromOrganization);
router.patch('/:id/members/:userId', isAuthenticated, adminRateLimiters.orgManagement, updateMemberRole);

// Transfer ownership (system admin can transfer any org)
router.patch('/:id/transfer-owner', isAuthenticated, adminRateLimiters.orgManagement, transferOrganizationOwnership);

// Legacy endpoints for regular org admins (their own org only)
router.post('/members', isAuthenticated, authorize('admin'), adminRateLimiters.orgManagement, addMember);
router.patch('/transfer-owner', isAuthenticated, authorize('admin'), adminRateLimiters.orgManagement, transferOwnership);

export default router;
