// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requirePermission } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  getMyOrganization,
  createOrganization,
  getOrgAIConfig,
  updateOrgAIConfig,
  getOrganizationById,
  getOrganizationDescendants,
  getOrganizationParent,
  updateOrganization,
  updateOrganizationTier,
  getOrganizationQuotas,
  updateOrganizationQuotas,
  updateOrganizationSeatLimit,
  getOrganizationSeatUsage,
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
  createOrganizationGroup,
  updateOrganizationGroup,
  deleteOrganizationGroup,
  addGroupMember,
  removeGroupMember,
} from '../controllers/index.js';
import { requireAuth, requireSystemAdmin, requireStepUp } from '../middleware/index.js';

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
router.post('/', requireAuth, requirePermission('org:settings'), createOrganization);

/*
 * AI Provider Configuration (must be before /:id routes)
 */

/** GET /organization/ai-config - Get org AI provider config */
router.get('/ai-config', requireAuth, getOrgAIConfig);

/** PUT /organization/ai-config - Update org AI provider keys (admin only) */
router.put('/ai-config', requireAuth, requirePermission('org:settings'), updateOrgAIConfig);

/*
 * Organization CRUD (system admin can access any org)
 */

/** GET /organization/:id - Get organization by ID */
router.get('/:id', requireAuth, getOrganizationById);

/** GET /:id/descendants - org→team subtree ids (self + descendants) */
router.get('/:id/descendants', requireAuth, getOrganizationDescendants);

/** GET /:id/parent — internal: direct parent id (service principal or org-admin,
 *  checked in the controller). Compliance's detached scheduled scans use it to
 *  evaluate parent `propagateToChildren` rules. */
router.get('/:id/parent', requireAuth, getOrganizationParent);

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
 *  Controller gates with `canAdministerOrg` (target-org scope); `requirePermission`
 *  is the capability gate (org:settings, in the admin/owner bundle). */
router.get('/:id/export', requireAuth, requirePermission('org:settings'), exportOrganization);

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

/** PUT /organization/:id/seat-limit — internal seat-entitlement sync from billing.
 *  Service-principal or sysadmin (checked in the controller); NO step-up, so the
 *  billing service can sync effective seats without a human MFA gate. */
router.put('/:id/seat-limit', requireAuth, updateOrganizationSeatLimit);

/** GET /organization/:id/seat-usage — internal pooled seat usage read for
 *  billing's over-cap gate. Service-principal or sysadmin (checked in controller). */
router.get('/:id/seat-usage', requireAuth, getOrganizationSeatUsage);

/*
 * Organization Members (admin can manage any org)
 */

/** GET /organization/:id/members - List organization members */
router.get('/:id/members', requireAuth, getOrganizationMembers);

/** POST /organization/:id/members - Add member to organization (admin only) */
router.post('/:id/members', requireAuth, requirePermission('members:manage'), addMemberToOrganization);

/** POST /organization/:id/members/bulk-add - Add one user to several teams in
 *  the org's subtree at once (admin/parent-admin only). */
router.post('/:id/members/bulk-add', requireAuth, requirePermission('members:manage'), bulkAddMemberToTeams);

/** GET /organization/:id/teams - Descendant team roster (no member context). */
router.get('/:id/teams', requireAuth, getOrganizationTeams);

/** GET /organization/:id/member/:memberId/teams - Descendant teams annotated
 *  with the member's membership (manage-teams view). */
router.get('/:id/member/:memberId/teams', requireAuth, getMemberTeams);

/** DELETE /organization/:id/members/:userId - Remove member from organization (admin only) */
router.delete('/:id/members/:userId', requireAuth, requirePermission('members:manage'), removeMemberFromOrganization);

/** PATCH /organization/:id/members/:userId - Update member role (admin only) */
router.patch('/:id/members/:userId', requireAuth, requirePermission('members:manage'), updateMemberRole);

/** PATCH /organization/:id/members/:userId/deactivate - Deactivate member (admin only) */
router.patch('/:id/members/:userId/deactivate', requireAuth, requirePermission('members:manage'), deactivateMember);

/** PATCH /organization/:id/members/:userId/activate - Reactivate member (admin only) */
router.patch('/:id/members/:userId/activate', requireAuth, requirePermission('members:manage'), activateMember);

/*
 * Permission Groups (first-class RBAC). Membership drives the cached
 * UserOrganization.role; Administrators → org-admin, Superadmins (system org
 * only) → platform admin.
 */

/** GET /organization/:id/groups - List groups + members */
router.get('/:id/groups', requireAuth, getOrganizationGroups);

/** POST /organization/:id/groups - Create a custom permission group (admin only) */
router.post('/:id/groups', requireAuth, requirePermission('groups:manage'), createOrganizationGroup);

/** PUT /organization/:id/groups/:groupId - Update a custom group (admin only) */
router.put('/:id/groups/:groupId', requireAuth, requirePermission('groups:manage'), updateOrganizationGroup);

/** DELETE /organization/:id/groups/:groupId - Delete a custom group (admin only) */
router.delete('/:id/groups/:groupId', requireAuth, requirePermission('groups:manage'), deleteOrganizationGroup);

/** POST /organization/:id/groups/:groupId/members - Add member to a group (admin only) */
router.post('/:id/groups/:groupId/members', requireAuth, requirePermission('groups:manage'), addGroupMember);

/** DELETE /organization/:id/groups/:groupId/members/:userId - Remove member from a group (admin only) */
router.delete('/:id/groups/:groupId/members/:userId', requireAuth, requirePermission('groups:manage'), removeGroupMember);

/*
 * Ownership Transfer
 */

/** PATCH /organization/:id/transfer-owner - Transfer organization ownership (admin only) */
router.patch('/:id/transfer-owner', requireAuth, requirePermission('org:settings'), requireStepUp, transferOrganizationOwnership);

export default router;
