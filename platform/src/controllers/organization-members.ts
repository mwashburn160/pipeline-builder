// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import {
  isSystemAdmin,
  requireAuth,
  getAdminContext,
  withController,
} from '../helpers/controller-helper';
import {
  orgMembersService,
  OM_ORG_NOT_FOUND, OM_USER_NOT_FOUND, OM_ALREADY_MEMBER, OM_NOT_A_MEMBER,
  OM_CANNOT_REMOVE_OWNER, OM_CANNOT_CHANGE_OWNER, OM_OWNER_MEMBERSHIP_NOT_FOUND,
  OM_NEW_OWNER_MUST_BE_MEMBER, OM_MEMBERSHIP_NOT_FOUND, OM_ALREADY_INACTIVE, OM_ALREADY_ACTIVE,
} from '../services';
import {
  validateBody,
  addMemberSchema,
  updateMemberRoleSchema,
  transferOwnershipSchema,
} from '../utils/validation';

const logger = createLogger('OrganizationMembersController');

/** GET /organization/:id/members */
export const getOrganizationMembers = withController('Get members', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  if (!isSystemAdmin(req) && req.user!.organizationId !== id) {
    return sendError(res, 403, 'Forbidden: Can only view members of your organization');
  }

  const result = await orgMembersService.listMembers(id);
  if (!result) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, { ...result, total: result.members.length });
});

/** POST /organization/:id/members */
export const addMemberToOrganization = withController('Add member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const admin = getAdminContext(req);
  if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
    return sendError(res, 403, 'Forbidden: Admin access required for this organization');
  }

  const body = validateBody(addMemberSchema, req.body, res);
  if (!body) return;

  await orgMembersService.addMember(id, body);
  logger.info(`[ADD MEMBER TO ORG] User added to Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  sendSuccess(res, 200, undefined, 'Member added successfully');
}, {
  [OM_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [OM_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [OM_ALREADY_MEMBER]: { status: 400, message: 'User is already a member of this organization' },
});

/** DELETE /organization/:id/members/:userId */
export const removeMemberFromOrganization = withController('Remove member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
    return sendError(res, 403, 'Forbidden: Admin access required for this organization');
  }
  if (admin.isOrgAdmin && userId === req.user!.sub) {
    return sendError(res, 400, 'Cannot remove yourself from the organization');
  }

  await orgMembersService.removeMember(id, userId);
  logger.info(`[REMOVE MEMBER FROM ORG] User ${userId} removed from Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  sendSuccess(res, 200, undefined, 'Member removed successfully');
}, {
  [OM_NOT_A_MEMBER]: { status: 400, message: 'User is not a member of this organization' },
  [OM_CANNOT_REMOVE_OWNER]: { status: 400, message: 'Cannot remove organization owner. Transfer ownership first.' },
});

/** PATCH /organization/:id/members/:userId */
export const updateMemberRole = withController('Update member role', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const body = validateBody(updateMemberRoleSchema, req.body, res);
  if (!body) return;

  const admin = getAdminContext(req);
  if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
    return sendError(res, 403, 'Forbidden: Admin access required for this organization');
  }
  if (admin.isOrgAdmin && userId === req.user!.sub) {
    return sendError(res, 400, 'Cannot change your own role');
  }

  const { user, role } = await orgMembersService.updateRole(id, userId, body.role);
  logger.info(`[UPDATE MEMBER ROLE] User ${userId} role updated to ${body.role} in Org ${id} by ${admin.adminType} ${req.user!.sub}`);

  sendSuccess(res, 200, {
    user: {
      id: user?._id.toString() ?? userId,
      username: user?.username,
      email: user?.email,
      role,
    },
  }, 'Member role updated successfully');
}, {
  [OM_NOT_A_MEMBER]: { status: 400, message: 'User is not a member of this organization' },
  [OM_CANNOT_CHANGE_OWNER]: { status: 400, message: 'Cannot change organization owner role. Transfer ownership first.' },
});

/** PATCH /organization/:id/transfer-owner */
export const transferOrganizationOwnership = withController('Transfer ownership', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const body = validateBody(transferOwnershipSchema, req.body, res);
  if (!body) return;

  const isSysAdmin = isSystemAdmin(req);
  const isOrgOwner = await orgMembersService.isOrgOwner(id, req.user!.sub);
  if (!isSysAdmin && !isOrgOwner) {
    return sendError(res, 403, 'Forbidden: Only system admin or organization owner can transfer ownership');
  }

  await orgMembersService.transferOwnership(id, body.newOwnerId);
  const adminType = isSysAdmin ? 'system admin' : 'org owner';
  logger.info(`[TRANSFER ORG OWNERSHIP] Org ${id} ownership transferred to ${body.newOwnerId} by ${adminType} ${req.user!.sub}`);
  sendSuccess(res, 200, undefined, 'Ownership transferred successfully');
}, {
  [OM_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [OM_OWNER_MEMBERSHIP_NOT_FOUND]: { status: 500, message: 'Current owner membership record not found' },
  [OM_NEW_OWNER_MUST_BE_MEMBER]: { status: 400, message: 'New owner must be a member of the organization' },
});

/** PATCH /organization/:id/members/:userId/deactivate */
export const deactivateMember = withController('Deactivate member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
    return sendError(res, 403, 'Forbidden: Admin access required for this organization');
  }

  await orgMembersService.deactivateMember(id, userId);
  logger.info(`[DEACTIVATE MEMBER] User ${userId} deactivated in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  sendSuccess(res, 200, undefined, 'Member deactivated successfully');
}, {
  [OM_MEMBERSHIP_NOT_FOUND]: { status: 404, message: 'Membership not found' },
  [OM_CANNOT_REMOVE_OWNER]: { status: 400, message: 'Cannot deactivate organization owner. Transfer ownership first.' },
  [OM_ALREADY_INACTIVE]: { status: 400, message: 'Member is already inactive' },
});

/** PATCH /organization/:id/members/:userId/activate */
export const activateMember = withController('Activate member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
    return sendError(res, 403, 'Forbidden: Admin access required for this organization');
  }

  await orgMembersService.activateMember(id, userId);
  logger.info(`[ACTIVATE MEMBER] User ${userId} reactivated in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  sendSuccess(res, 200, undefined, 'Member reactivated successfully');
}, {
  [OM_MEMBERSHIP_NOT_FOUND]: { status: 404, message: 'Membership not found' },
  [OM_ALREADY_ACTIVE]: { status: 400, message: 'Member is already active' },
});
