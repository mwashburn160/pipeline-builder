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
  listRolesWithMembers,
  addUserToRole,
  removeUserFromRole,
  createRole,
  updateRole,
  deleteRole,
  RL_ROLE_NOT_FOUND,
  RL_USER_NOT_FOUND,
  RL_NOT_ORG_MEMBER,
  RL_CANNOT_REMOVE_SELF,
  RL_LAST_PRIVILEGED_MEMBER,
  RL_REQUIRES_SUPERADMIN,
  RL_SYSTEM_IMMUTABLE,
  RL_NAME_TAKEN,
  RL_INVALID_PERMISSION,
} from '../services/index.js';
import { validateBody, addRoleMemberSchema, createRoleSchema, updateRoleSchema } from '../utils/validation.js';

const logger = createLogger('organization-roles-controller');

/** GET /organization/:id/roles — list permission Roles + their members. */
export const getOrganizationRoles = withController('Get roles', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  // Read-level gate: own org (any member), a managed team (parent admin), or sysadmin.
  if (!(await canAccessOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: Can only view roles within your organization');
  }

  const roles = await listRolesWithMembers(id);
  sendSuccess(res, 200, { roles });
});

/** POST /organization/:id/roles — create a custom permission Role. */
export const createOrganizationRole = withController('Create role', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  if (!(await requireOrgAdmin(req, res, id))) return;

  const body = validateBody(createRoleSchema, req.body, res);
  if (!body) return;

  const role = await createRole(id, body);
  audit(req, 'org.role.create', { targetType: 'role', targetId: role.id, affectedOrgId: id });
  sendSuccess(res, 201, { role }, 'Role created');
}, {
  [RL_NAME_TAKEN]: { status: 409, message: 'A role with this name already exists' },
  [RL_INVALID_PERMISSION]: { status: 400, message: 'One or more permissions are not recognized' },
});

/** PUT /organization/:id/roles/:roleId — update a custom Role's name/description/permissions. */
export const updateOrganizationRole = withController('Update role', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const roleId = req.params.roleId as string;
  if (!(await requireOrgAdmin(req, res, id))) return;

  const body = validateBody(updateRoleSchema, req.body, res);
  if (!body) return;

  const role = await updateRole(id, roleId, body);
  audit(req, 'org.role.update', { targetType: 'role', targetId: roleId, affectedOrgId: id });
  sendSuccess(res, 200, { role }, 'Role updated');
}, {
  [RL_ROLE_NOT_FOUND]: { status: 404, message: 'Role not found' },
  [RL_SYSTEM_IMMUTABLE]: { status: 400, message: 'Built-in roles cannot be modified' },
  [RL_NAME_TAKEN]: { status: 409, message: 'A role with this name already exists' },
  [RL_INVALID_PERMISSION]: { status: 400, message: 'One or more permissions are not recognized' },
});

/** DELETE /organization/:id/roles/:roleId — delete a custom Role. */
export const deleteOrganizationRole = withController('Delete role', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const roleId = req.params.roleId as string;
  if (!(await requireOrgAdmin(req, res, id))) return;

  await deleteRole(id, roleId);
  audit(req, 'org.role.delete', { targetType: 'role', targetId: roleId, affectedOrgId: id });
  sendSuccess(res, 200, undefined, 'Role deleted');
}, {
  [RL_ROLE_NOT_FOUND]: { status: 404, message: 'Role not found' },
  [RL_SYSTEM_IMMUTABLE]: { status: 400, message: 'Built-in roles cannot be deleted' },
});

/** POST /organization/:id/roles/:roleId/members — assign an org member to a Role. */
export const addRoleMember = withController('Add role member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const roleId = req.params.roleId as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgAdmin(req, res, id))) return;

  const body = validateBody(addRoleMemberSchema, req.body, res);
  if (!body) return;

  const { userId } = await addUserToRole(id, roleId, body, admin.isSuperAdmin);
  logger.info(`[ADD ROLE MEMBER] User ${userId} assigned to role ${roleId} in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.role.member.add', {
    targetType: 'user',
    targetId: userId,
    affectedOrgId: id,
    groupId: roleId,
  });
  sendSuccess(res, 200, { userId }, 'Member added to role');
}, {
  [RL_ROLE_NOT_FOUND]: { status: 404, message: 'Role not found' },
  [RL_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [RL_NOT_ORG_MEMBER]: { status: 400, message: 'User must be a member of the organization before joining a role' },
  [RL_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can manage members of a superadmin role' },
});

/** DELETE /organization/:id/roles/:roleId/members/:userId — remove from a Role.
 *  Recomputes the user's cached role; in the system org, leaving Super Admin
 *  also clears their platform-admin flag. */
export const removeRoleMember = withController('Remove role member', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id as string;
  const roleId = req.params.roleId as string;
  const userId = req.params.userId as string;
  const admin = getAdminContext(req);
  if (!(await requireOrgAdmin(req, res, id))) return;

  await removeUserFromRole(id, roleId, userId, { actorUserId: req.user!.sub, actorIsSuperAdmin: admin.isSuperAdmin });
  logger.info(`[REMOVE ROLE MEMBER] User ${userId} removed from role ${roleId} in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'org.role.member.remove', {
    targetType: 'user',
    targetId: userId,
    affectedOrgId: id,
    groupId: roleId,
  });
  sendSuccess(res, 200, undefined, 'Member removed from role');
}, {
  [RL_ROLE_NOT_FOUND]: { status: 404, message: 'Role not found' },
  [RL_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can manage members of a superadmin role' },
  [RL_CANNOT_REMOVE_SELF]: { status: 400, message: 'You cannot remove yourself from this role — it grants your own admin access. Have another admin do it, or assign a replacement first.' },
  [RL_LAST_PRIVILEGED_MEMBER]: { status: 400, message: 'Cannot remove the last member of this role — the organization would be left with no one in this role. Add another member first.' },
});
