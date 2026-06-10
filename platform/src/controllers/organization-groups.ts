// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import {
  canAccessOrg,
  canAdministerOrg,
  getAdminContext,
  requireAuth,
  withController,
} from '../helpers/controller-helper.js';
import {
  listGroupsWithMembers,
  addUserToGroup,
  removeUserFromGroup,
  GRP_GROUP_NOT_FOUND,
  GRP_USER_NOT_FOUND,
  GRP_NOT_ORG_MEMBER,
  GRP_CANNOT_REMOVE_SELF,
  GRP_LAST_PRIVILEGED_MEMBER,
  GRP_REQUIRES_SUPERADMIN,
} from '../services/index.js';
import { validateBody, addGroupMemberSchema } from '../utils/validation.js';

const logger = createLogger('organization-groups-controller');

/** GET /organization/:id/groups — list permission groups + their members. */
export const getOrganizationGroups = withController('Get groups', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  // Read-level gate: own org (any member), a managed team (parent admin), or sysadmin.
  if (!(await canAccessOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: Can only view groups within your organization');
  }

  const groups = await listGroupsWithMembers(id);
  sendSuccess(res, 200, { groups });
});

/** POST /organization/:id/groups/:groupId/members — add an org member to a group. */
export const addGroupMember = withController('Add group member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const groupId = req.params.groupId as string;
  const admin = getAdminContext(req);
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: Admin access required for this organization');
  }

  const body = validateBody(addGroupMemberSchema, req.body, res);
  if (!body) return;

  const { userId } = await addUserToGroup(id, groupId, body, admin.isSuperAdmin);
  logger.info(`[ADD GROUP MEMBER] User ${userId} added to group ${groupId} in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.group.member.add', {
    targetType: 'user',
    targetId: userId,
    affectedOrgId: id,
    groupId,
  });
  sendSuccess(res, 200, { userId }, 'Member added to group');
}, {
  [GRP_GROUP_NOT_FOUND]: { status: 404, message: 'Group not found' },
  [GRP_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [GRP_NOT_ORG_MEMBER]: { status: 400, message: 'User must be a member of the organization before joining a group' },
  [GRP_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can manage members of a superadmin group' },
});

/** DELETE /organization/:id/groups/:groupId/members/:userId — remove from a group.
 *  Recomputes the user's cached role; in the system org, leaving Superadmins
 *  also clears their platform-admin flag. */
export const removeGroupMember = withController('Remove group member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const groupId = req.params.groupId as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: Admin access required for this organization');
  }

  await removeUserFromGroup(id, groupId, userId, { actorUserId: req.user!.sub, actorIsSuperAdmin: admin.isSuperAdmin });
  logger.info(`[REMOVE GROUP MEMBER] User ${userId} removed from group ${groupId} in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.group.member.remove', {
    targetType: 'user',
    targetId: userId,
    affectedOrgId: id,
    groupId,
  });
  sendSuccess(res, 200, undefined, 'Member removed from group');
}, {
  [GRP_GROUP_NOT_FOUND]: { status: 404, message: 'Group not found' },
  [GRP_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can manage members of a superadmin group' },
  [GRP_CANNOT_REMOVE_SELF]: { status: 400, message: 'You cannot remove yourself from this group — it grants your own admin access. Have another admin do it, or assign a replacement first.' },
  [GRP_LAST_PRIVILEGED_MEMBER]: { status: 400, message: 'Cannot remove the last member of this group — the organization would be left with no one in this role. Add another member first.' },
});
