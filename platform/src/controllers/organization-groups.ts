// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import {
  canAccessOrg,
  requireOrgAdmin,
  getAdminContext,
  requireAuth,
  withController,
} from '../helpers/controller-helper.js';
import {
  listGroupsWithMembers,
  addUserToGroup,
  removeUserFromGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  GRP_GROUP_NOT_FOUND,
  GRP_USER_NOT_FOUND,
  GRP_NOT_ORG_MEMBER,
  GRP_CANNOT_REMOVE_SELF,
  GRP_LAST_PRIVILEGED_MEMBER,
  GRP_REQUIRES_SUPERADMIN,
  GRP_SYSTEM_IMMUTABLE,
  GRP_NAME_TAKEN,
  GRP_INVALID_PERMISSION,
} from '../services/index.js';
import { validateBody, addGroupMemberSchema, createGroupSchema, updateGroupSchema } from '../utils/validation.js';

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

/** POST /organization/:id/groups — create a custom permission group. */
export const createOrganizationGroup = withController('Create group', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  if (!(await requireOrgAdmin(req, res, id))) return;

  const body = validateBody(createGroupSchema, req.body, res);
  if (!body) return;

  const group = await createGroup(id, body);
  audit(req, 'org.group.create', { targetType: 'group', targetId: group.id, affectedOrgId: id });
  sendSuccess(res, 201, { group }, 'Group created');
}, {
  [GRP_NAME_TAKEN]: { status: 409, message: 'A group with this name already exists' },
  [GRP_INVALID_PERMISSION]: { status: 400, message: 'One or more permissions are not recognized' },
});

/** PUT /organization/:id/groups/:groupId — update a custom group's name/description/permissions. */
export const updateOrganizationGroup = withController('Update group', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const groupId = req.params.groupId as string;
  if (!(await requireOrgAdmin(req, res, id))) return;

  const body = validateBody(updateGroupSchema, req.body, res);
  if (!body) return;

  const group = await updateGroup(id, groupId, body);
  audit(req, 'org.group.update', { targetType: 'group', targetId: groupId, affectedOrgId: id });
  sendSuccess(res, 200, { group }, 'Group updated');
}, {
  [GRP_GROUP_NOT_FOUND]: { status: 404, message: 'Group not found' },
  [GRP_SYSTEM_IMMUTABLE]: { status: 400, message: 'Built-in groups cannot be modified' },
  [GRP_NAME_TAKEN]: { status: 409, message: 'A group with this name already exists' },
  [GRP_INVALID_PERMISSION]: { status: 400, message: 'One or more permissions are not recognized' },
});

/** DELETE /organization/:id/groups/:groupId — delete a custom group. */
export const deleteOrganizationGroup = withController('Delete group', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const groupId = req.params.groupId as string;
  if (!(await requireOrgAdmin(req, res, id))) return;

  await deleteGroup(id, groupId);
  audit(req, 'org.group.delete', { targetType: 'group', targetId: groupId, affectedOrgId: id });
  sendSuccess(res, 200, undefined, 'Group deleted');
}, {
  [GRP_GROUP_NOT_FOUND]: { status: 404, message: 'Group not found' },
  [GRP_SYSTEM_IMMUTABLE]: { status: 400, message: 'Built-in groups cannot be deleted' },
});

/** POST /organization/:id/groups/:groupId/members — add an org member to a group. */
export const addGroupMember = withController('Add group member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const groupId = req.params.groupId as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgAdmin(req, res, id))) return;

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
  if (!(await requireOrgAdmin(req, res, id))) return;

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
