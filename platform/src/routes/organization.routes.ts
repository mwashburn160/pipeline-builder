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
import { isAuthenticated } from '../middleware';

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

/** PUT /organization/:id - Update organization */
router.put('/:id', isAuthenticated, updateOrganization);

/** DELETE /organization/:id - Delete organization */
router.delete('/:id', isAuthenticated, deleteOrganization);

/*
 * Organization Quotas
 */

/** GET /organization/:id/quotas - Get organization quota limits and usage */
router.get('/:id/quotas', isAuthenticated, getOrganizationQuotas);

/** PUT /organization/:id/quotas - Update organization quota limits (system admin only) */
router.put('/:id/quotas', isAuthenticated, updateOrganizationQuotas);

/*
 * Organization Members (system admin can manage any org)
 */

/** GET /organization/:id/members - List organization members */
router.get('/:id/members', isAuthenticated, getOrganizationMembers);

/** POST /organization/:id/members - Add member to organization */
router.post('/:id/members', isAuthenticated, addMemberToOrganization);

/** DELETE /organization/:id/members/:userId - Remove member from organization */
router.delete('/:id/members/:userId', isAuthenticated, removeMemberFromOrganization);

/** PATCH /organization/:id/members/:userId - Update member role */
router.patch('/:id/members/:userId', isAuthenticated, updateMemberRole);

/*
 * Ownership Transfer
 */

/** PATCH /organization/:id/transfer-owner - Transfer organization ownership */
router.patch('/:id/transfer-owner', isAuthenticated, transferOrganizationOwnership);

export default router;
