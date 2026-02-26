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
import { authenticateToken, requireRole } from '../middleware';

const router = Router();

/*
 * Current User's Organization
 */

/** GET /organization - Get current user's organization */
router.get('/', authenticateToken, getMyOrganization);

/*
 * AI Provider Configuration (must be before /:id routes)
 */

/** GET /organization/ai-config - Get org AI provider config */
router.get('/ai-config', authenticateToken, getOrgAIConfig);

/** PUT /organization/ai-config - Update org AI provider keys (admin only) */
router.put('/ai-config', authenticateToken, requireRole('admin'), updateOrgAIConfig);

/*
 * Organization CRUD (system admin can access any org)
 */

/** GET /organization/:id - Get organization by ID */
router.get('/:id', authenticateToken, getOrganizationById);

/** PUT /organization/:id - Update organization (admin only) */
router.put('/:id', authenticateToken, requireRole('admin'), updateOrganization);

/** DELETE /organization/:id - Delete organization (admin only) */
router.delete('/:id', authenticateToken, requireRole('admin'), deleteOrganization);

/*
 * Organization Quotas
 */

/** GET /organization/:id/quotas - Get organization quota limits and usage */
router.get('/:id/quotas', authenticateToken, getOrganizationQuotas);

/** PUT /organization/:id/quotas - Update organization quota limits (system admin only) */
router.put('/:id/quotas', authenticateToken, requireRole('admin'), updateOrganizationQuotas);

/*
 * Organization Members (admin can manage any org)
 */

/** GET /organization/:id/members - List organization members */
router.get('/:id/members', authenticateToken, getOrganizationMembers);

/** POST /organization/:id/members - Add member to organization (admin only) */
router.post('/:id/members', authenticateToken, requireRole('admin'), addMemberToOrganization);

/** DELETE /organization/:id/members/:userId - Remove member from organization (admin only) */
router.delete('/:id/members/:userId', authenticateToken, requireRole('admin'), removeMemberFromOrganization);

/** PATCH /organization/:id/members/:userId - Update member role (admin only) */
router.patch('/:id/members/:userId', authenticateToken, requireRole('admin'), updateMemberRole);

/*
 * Ownership Transfer
 */

/** PATCH /organization/:id/transfer-owner - Transfer organization ownership (admin only) */
router.patch('/:id/transfer-owner', authenticateToken, requireRole('admin'), transferOrganizationOwnership);

export default router;
