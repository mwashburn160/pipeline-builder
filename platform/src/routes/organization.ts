// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import {
  getMyOrganization,
  createOrganization,
  getOrgAIConfig,
  updateOrgAIConfig,
  getOrganizationById,
  getOrganizationDescendants,
  updateOrganization,
  updateOrganizationTier,
  getOrganizationQuotas,
  updateOrganizationQuotas,
  getOrganizationMembers,
  getOrganizationTeams,
  getMemberTeams,
  addMemberToOrganization,
  bulkAddMemberToTeams,
  removeMemberFromOrganization,
  updateMemberRole,
  transferOrganizationOwnership,
  deactivateMember,
  activateMember,
  deleteOrganization,
  exportOrganization,
  getOrganizationGroups,
  addGroupMember,
  removeGroupMember,
} from '../controllers';
import { requireAuth, requireRole, requireSystemAdmin, requireStepUp } from '../middleware';

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

/** GET /:id/descendants - org→team subtree ids (self + descendants) */
router.get('/:id/descendants', requireAuth, getOrganizationDescendants);

/** PUT /organization/:id - Update organization (sysadmin only).
 *  `requireSystemAdmin` mirrors the controller's own check at the route layer
 *  so org admins/owners are rejected here, not deeper in. */
router.put('/:id', requireAuth, requireSystemAdmin, updateOrganization);

/** PATCH /organization/:id/tier - Change pricing tier (sysadmin only).
 *  Step-up gated because the change resizes quota limits and affects billing. */
router.patch('/:id/tier', requireAuth, requireSystemAdmin, requireStepUp, updateOrganizationTier);

/** DELETE /organization/:id - Delete organization (sysadmin only). */
router.delete('/:id', requireAuth, requireSystemAdmin, requireStepUp, deleteOrganization);

/** GET /organization/:id/export - GDPR portability dump (org admin or sysadmin).
 *  Controller gates with `canAdministerOrg`, so an org's own admin can export it;
 *  `requireRole('admin','owner')` is the matching route guard. */
router.get('/:id/export', requireAuth, requireRole('admin', 'owner'), exportOrganization);

/*
 * Organization Quotas
 */

/** GET /organization/:id/quotas - Get organization quota limits and usage */
router.get('/:id/quotas', requireAuth, getOrganizationQuotas);

/** PUT /organization/:id/quotas - Update organization quota limits (sysadmin only).
 *  `requireSystemAdmin` mirrors the controller's gate at the route layer.
 *  Step-up gated like the tier change: resizing quota limits has billing/capacity
 *  impact, so a stale sysadmin session must re-confirm before it lands. */
router.put('/:id/quotas', requireAuth, requireSystemAdmin, requireStepUp, updateOrganizationQuotas);

/*
 * Organization Members (admin can manage any org)
 */

/** GET /organization/:id/members - List organization members */
router.get('/:id/members', requireAuth, getOrganizationMembers);

/** POST /organization/:id/members - Add member to organization (admin only) */
router.post('/:id/members', requireAuth, requireRole('admin', 'owner'), addMemberToOrganization);

/** POST /organization/:id/members/bulk-add - Add one user to several teams in
 *  the org's subtree at once (admin/parent-admin only). */
router.post('/:id/members/bulk-add', requireAuth, requireRole('admin', 'owner'), bulkAddMemberToTeams);

/** GET /organization/:id/teams - Descendant team roster (no member context). */
router.get('/:id/teams', requireAuth, getOrganizationTeams);

/** GET /organization/:id/member/:memberId/teams - Descendant teams annotated
 *  with the member's membership (manage-teams view). */
router.get('/:id/member/:memberId/teams', requireAuth, getMemberTeams);

/** DELETE /organization/:id/members/:userId - Remove member from organization (admin only) */
router.delete('/:id/members/:userId', requireAuth, requireRole('admin', 'owner'), removeMemberFromOrganization);

/** PATCH /organization/:id/members/:userId - Update member role (admin only) */
router.patch('/:id/members/:userId', requireAuth, requireRole('admin', 'owner'), updateMemberRole);

/** PATCH /organization/:id/members/:userId/deactivate - Deactivate member (admin only) */
router.patch('/:id/members/:userId/deactivate', requireAuth, requireRole('admin', 'owner'), deactivateMember);

/** PATCH /organization/:id/members/:userId/activate - Reactivate member (admin only) */
router.patch('/:id/members/:userId/activate', requireAuth, requireRole('admin', 'owner'), activateMember);

/*
 * Permission Groups (first-class RBAC). Membership drives the cached
 * UserOrganization.role; Administrators → org-admin, Superadmins (system org
 * only) → platform admin.
 */

/** GET /organization/:id/groups - List groups + members */
router.get('/:id/groups', requireAuth, getOrganizationGroups);

/** POST /organization/:id/groups/:groupId/members - Add member to a group (admin only) */
router.post('/:id/groups/:groupId/members', requireAuth, requireRole('admin', 'owner'), addGroupMember);

/** DELETE /organization/:id/groups/:groupId/members/:userId - Remove member from a group (admin only) */
router.delete('/:id/groups/:groupId/members/:userId', requireAuth, requireRole('admin', 'owner'), removeGroupMember);

/*
 * Ownership Transfer
 */

/** PATCH /organization/:id/transfer-owner - Transfer organization ownership (admin only) */
router.patch('/:id/transfer-owner', requireAuth, requireRole('admin', 'owner'), requireStepUp, transferOrganizationOwnership);

export default router;
