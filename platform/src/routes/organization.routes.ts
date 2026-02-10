/**
 * @module routes/organization
 * @description Organization management routes including CRUD, member management,
 * quota configuration, and ownership transfer.
 * System admins can access any organization; org admins can only access their own.
 */

import { Router } from 'express';
import {
  getMyOrganization,
  getOrganizationById,
  updateOrganization,
  getOrganizationQuotas,
  updateOrganizationQuotas,
  getOrganizationMembers,
  addMemberToOrganization,
  removeMemberFromOrganization,
  updateMemberRole,
  transferOrganizationOwnership,
  deleteOrganization,
} from '../controllers';
import { isAuthenticated, authorize } from '../middleware';

const router = Router();

/*
 * Current User's Organization
 */

/** GET /organization - Get current user's organization */
router.get('/', isAuthenticated, getMyOrganization);

/*
 * Organization CRUD (system admin can access any org)
 */

/** GET /organization/:id - Get organization by ID */
router.get('/:id', isAuthenticated, getOrganizationById);

/** PUT /organization/:id - Update organization (admin only) */
router.put('/:id', isAuthenticated, authorize('admin'), updateOrganization);

/** DELETE /organization/:id - Delete organization (admin only) */
router.delete('/:id', isAuthenticated, authorize('admin'), deleteOrganization);

/*
 * Organization Quotas
 */

/** GET /organization/:id/quotas - Get organization quota limits and usage */
router.get('/:id/quotas', isAuthenticated, getOrganizationQuotas);

/** PUT /organization/:id/quotas - Update organization quota limits (system admin only) */
router.put('/:id/quotas', isAuthenticated, authorize('admin'), updateOrganizationQuotas);

/*
 * Organization Members (admin can manage any org)
 */

/** GET /organization/:id/members - List organization members */
router.get('/:id/members', isAuthenticated, getOrganizationMembers);

/** POST /organization/:id/members - Add member to organization (admin only) */
router.post('/:id/members', isAuthenticated, authorize('admin'), addMemberToOrganization);

/** DELETE /organization/:id/members/:userId - Remove member from organization (admin only) */
router.delete('/:id/members/:userId', isAuthenticated, authorize('admin'), removeMemberFromOrganization);

/** PATCH /organization/:id/members/:userId - Update member role (admin only) */
router.patch('/:id/members/:userId', isAuthenticated, authorize('admin'), updateMemberRole);

/*
 * Ownership Transfer
 */

/** PATCH /organization/:id/transfer-owner - Transfer organization ownership (admin only) */
router.patch('/:id/transfer-owner', isAuthenticated, authorize('admin'), transferOrganizationOwnership);

export default router;
