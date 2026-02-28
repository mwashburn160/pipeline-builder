/**
 * @module routes/organization
 * @description Organization management routes including CRUD, member management,
 * quota configuration, and ownership transfer.
 * System admins can access any organization; org admins can only access their own.
 */

import { Router } from 'express';
import {
  getMyOrganization,
  getOrgAIConfig,
  updateOrgAIConfig,
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
import { requireAuth, requireRole } from '../middleware';

const router = Router();

/*
 * Current User's Organization
 */

/** GET /organization - Get current user's organization */
router.get('/', requireAuth, getMyOrganization);

/*
 * AI Provider Configuration (must be before /:id routes)
 */

/** GET /organization/ai-config - Get org AI provider config */
router.get('/ai-config', requireAuth, getOrgAIConfig);

/** PUT /organization/ai-config - Update org AI provider keys (admin only) */
router.put('/ai-config', requireAuth, requireRole('admin'), updateOrgAIConfig);

/*
 * Organization CRUD (system admin can access any org)
 */

/** GET /organization/:id - Get organization by ID */
router.get('/:id', requireAuth, getOrganizationById);

/** PUT /organization/:id - Update organization (admin only) */
router.put('/:id', requireAuth, requireRole('admin'), updateOrganization);

/** DELETE /organization/:id - Delete organization (admin only) */
router.delete('/:id', requireAuth, requireRole('admin'), deleteOrganization);

/*
 * Organization Quotas
 */

/** GET /organization/:id/quotas - Get organization quota limits and usage */
router.get('/:id/quotas', requireAuth, getOrganizationQuotas);

/** PUT /organization/:id/quotas - Update organization quota limits (system admin only) */
router.put('/:id/quotas', requireAuth, requireRole('admin'), updateOrganizationQuotas);

/*
 * Organization Members (admin can manage any org)
 */

/** GET /organization/:id/members - List organization members */
router.get('/:id/members', requireAuth, getOrganizationMembers);

/** POST /organization/:id/members - Add member to organization (admin only) */
router.post('/:id/members', requireAuth, requireRole('admin'), addMemberToOrganization);

/** DELETE /organization/:id/members/:userId - Remove member from organization (admin only) */
router.delete('/:id/members/:userId', requireAuth, requireRole('admin'), removeMemberFromOrganization);

/** PATCH /organization/:id/members/:userId - Update member role (admin only) */
router.patch('/:id/members/:userId', requireAuth, requireRole('admin'), updateMemberRole);

/*
 * Ownership Transfer
 */

/** PATCH /organization/:id/transfer-owner - Transfer organization ownership (admin only) */
router.patch('/:id/transfer-owner', requireAuth, requireRole('admin'), transferOrganizationOwnership);

export default router;
