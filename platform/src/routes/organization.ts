// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import {
  getMyOrganization,
  createOrganization,
  getOrgAIConfig,
  updateOrgAIConfig,
  getOrganizationById,
  updateOrganization,
  updateOrganizationTier,
  getOrganizationQuotas,
  updateOrganizationQuotas,
  getOrganizationMembers,
  addMemberToOrganization,
  removeMemberFromOrganization,
  updateMemberRole,
  transferOrganizationOwnership,
  deactivateMember,
  activateMember,
  deleteOrganization,
  exportOrganization,
} from '../controllers';
import { requireAuth, requireRole, requireStepUp } from '../middleware';

const router = Router();

/*
 * Current User's Organization
 */

/** GET /organization - Get current user's organization */
router.get('/', requireAuth, getMyOrganization);

/** POST /organization - Create a new organization (admin or owner only).
 *  Note: self-serve org creation for brand-new users goes through
 *  /auth/register (which creates a paired user+org), NOT this endpoint.
 *  This route is for already-org-bound admins/owners adding *additional*
 *  orgs to their account. */
router.post('/', requireAuth, requireRole('admin', 'owner'), createOrganization);

/*
 * AI Provider Configuration (must be before /:id routes)
 */

/** GET /organization/ai-config - Get org AI provider config */
router.get('/ai-config', requireAuth, getOrgAIConfig);

/** PUT /organization/ai-config - Update org AI provider keys (admin only) */
router.put('/ai-config', requireAuth, requireRole('admin', 'owner'), updateOrgAIConfig);

/*
 * Organization CRUD (system admin can access any org)
 */

/** GET /organization/:id - Get organization by ID */
router.get('/:id', requireAuth, getOrganizationById);

/** PUT /organization/:id - Update organization (sysadmin only).
 *  Controller enforces `requireSystemAdmin`, which is the stricter gate;
 *  the route-level `requireRole('admin','owner')` was redundant and
 *  misleading (org admins/owners do NOT get to PUT this endpoint). */
router.put('/:id', requireAuth, updateOrganization);

/** PATCH /organization/:id/tier - Change pricing tier (sysadmin only).
 *  Step-up gated because the change resizes quota limits and affects billing. */
router.patch('/:id/tier', requireAuth, requireRole('admin', 'owner'), requireStepUp, updateOrganizationTier);

/** DELETE /organization/:id - Delete organization (admin only) */
router.delete('/:id', requireAuth, requireRole('admin', 'owner'), requireStepUp, deleteOrganization);

/** GET /organization/:id/export - GDPR portability dump (, sysadmin only) */
router.get('/:id/export', requireAuth, requireRole('admin', 'owner'), exportOrganization);

/*
 * Organization Quotas
 */

/** GET /organization/:id/quotas - Get organization quota limits and usage */
router.get('/:id/quotas', requireAuth, getOrganizationQuotas);

/** PUT /organization/:id/quotas - Update organization quota limits (sysadmin only).
 *  Controller enforces `requireSystemAdmin`; route-level role gate was
 *  redundant and would have implied (incorrectly) that org admins qualify. */
router.put('/:id/quotas', requireAuth, updateOrganizationQuotas);

/*
 * Organization Members (admin can manage any org)
 */

/** GET /organization/:id/members - List organization members */
router.get('/:id/members', requireAuth, getOrganizationMembers);

/** POST /organization/:id/members - Add member to organization (admin only) */
router.post('/:id/members', requireAuth, requireRole('admin', 'owner'), addMemberToOrganization);

/** DELETE /organization/:id/members/:userId - Remove member from organization (admin only) */
router.delete('/:id/members/:userId', requireAuth, requireRole('admin', 'owner'), removeMemberFromOrganization);

/** PATCH /organization/:id/members/:userId - Update member role (admin only) */
router.patch('/:id/members/:userId', requireAuth, requireRole('admin', 'owner'), updateMemberRole);

/** PATCH /organization/:id/members/:userId/deactivate - Deactivate member (admin only) */
router.patch('/:id/members/:userId/deactivate', requireAuth, requireRole('admin', 'owner'), deactivateMember);

/** PATCH /organization/:id/members/:userId/activate - Reactivate member (admin only) */
router.patch('/:id/members/:userId/activate', requireAuth, requireRole('admin', 'owner'), activateMember);

/*
 * Ownership Transfer
 */

/** PATCH /organization/:id/transfer-owner - Transfer organization ownership (admin only) */
router.patch('/:id/transfer-owner', requireAuth, requireRole('admin', 'owner'), requireStepUp, transferOrganizationOwnership);

export default router;
