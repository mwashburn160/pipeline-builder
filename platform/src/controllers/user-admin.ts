// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, resolveUserFeatures, isValidFeatureFlag, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { config } from '../config';
import { formatUserResponse, toOverridesRecord } from './user-profile';
import type { OrgSummary, OrgMembership, UserResponseInput } from './user-profile';
import { audit } from '../helpers/audit';
import { requireAdminContext, withController } from '../helpers/controller-helper';
import {
  userAdminService,
  UA_USER_NOT_FOUND,
  UA_USERNAME_TAKEN,
  UA_EMAIL_TAKEN,
  UA_OWNER_HAS_ORGS,
  UA_ORG_NOT_FOUND,
} from '../services';
import { parsePagination } from '../utils/pagination';

const logger = createLogger('UserAdminController');

const adminErrorMap = {
  [UA_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [UA_USERNAME_TAKEN]: { status: 409, message: 'Username already in use' },
  [UA_EMAIL_TAKEN]: { status: 409, message: 'Email already in use' },
  [UA_OWNER_HAS_ORGS]: { status: 400, message: 'Cannot delete user who is an organization owner. Transfer ownership first.' },
  [UA_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
};

/**
 * GET /users — list users.
 * System admin: all users (or scoped to a query org). Org admin: own org only.
 */
export const listAllUsers = withController('List users', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const { organizationId, role, search } = req.query;

  // Compute the user-id scope based on admin type + filters.
  let scopedUserIds: Types.ObjectId[] | null = null;
  let effectiveScopeOrgId: string | undefined;

  if (admin.isOrgAdmin) {
    const reqOrgId = req.user!.organizationId!;
    if (organizationId && organizationId !== reqOrgId) {
      return sendError(res, 403, 'Forbidden: Can only view users in your organization');
    }
    effectiveScopeOrgId = reqOrgId;
    scopedUserIds = await userAdminService.getUserIdsInOrg(reqOrgId);
  } else if (organizationId) {
    effectiveScopeOrgId = organizationId as string;
    scopedUserIds = await userAdminService.getUserIdsInOrg(effectiveScopeOrgId);
  }

  if (role && ['owner', 'admin', 'member'].includes(role as string) && effectiveScopeOrgId) {
    const roleMembers = await userAdminService.getUserIdsByRoleInOrg(effectiveScopeOrgId, role as string);
    if (scopedUserIds !== null) {
      const roleSet = new Set(roleMembers.map(id => id.toString()));
      scopedUserIds = scopedUserIds.filter(id => roleSet.has(id.toString()));
    } else {
      scopedUserIds = roleMembers;
    }
  }

  const { offset, limit: limitNum } = parsePagination(req.query.offset, req.query.limit);
  const { users, total, membershipsByUser, orgNameMap } = await userAdminService.list(
    scopedUserIds,
    { search: search as string | undefined },
    offset,
    limitNum,
  );

  const usersWithOrg = users.map(user => {
    const userMemberships = membershipsByUser.get((user._id as { toString(): string }).toString()) || [];
    const activeOrgId = (user.lastActiveOrgId as { toString(): string } | undefined)?.toString();
    const activeMembership = activeOrgId
      ? userMemberships.find(m => m.organizationId.toString() === activeOrgId)
      : undefined;

    return formatUserResponse(user as unknown as UserResponseInput, {
      activeOrgRole: activeMembership?.role,
      activeOrgName: activeOrgId ? orgNameMap.get(activeOrgId) || null : null,
    });
  });

  sendSuccess(res, 200, {
    users: usersWithOrg,
    pagination: { total, offset, limit: limitNum, hasMore: offset + limitNum < total },
  });
});

/** GET /users/:id — single user (sysadmin or org-admin within their org). */
export const getUserById = withController('Get user', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const { id } = req.params;
  const { user, memberships, orgMap } = await userAdminService.getByIdWithOrgs(id as string);

  // Org-admin authz: target must be a member of the admin's org.
  if (admin.isOrgAdmin) {
    const allowed = await userAdminService.hasMembershipInOrg(user._id, req.user!.organizationId!);
    if (!allowed) return sendError(res, 403, 'Forbidden: Can only view users in your organization');
  }

  const organizations: OrgMembership[] = memberships.map(m => {
    const org = orgMap.get(m.organizationId.toString());
    return { id: m.organizationId.toString(), name: org?.name || 'Unknown', role: m.role };
  });

  const activeOrgId = user.lastActiveOrgId?.toString();
  let organizationName: string | null = null;
  let organization: OrgSummary | undefined;
  let activeOrgRole: string | undefined;
  let tier: QuotaTier = 'developer';
  let isSystem = false;

  if (activeOrgId) {
    const activeOrg = orgMap.get(activeOrgId);
    if (activeOrg) {
      organizationName = activeOrg.name;
      organization = { id: activeOrg._id.toString(), name: activeOrg.name, slug: activeOrg.slug };
      tier = (activeOrg.tier as QuotaTier) || 'developer';
      isSystem = activeOrg._id.toString() === SYSTEM_ORG_ID;
    }
    const activeMembership = memberships.find(m => m.organizationId.toString() === activeOrgId);
    activeOrgRole = activeMembership?.role;
  }

  const overrides = toOverridesRecord(user.featureOverrides as Map<string, boolean> | undefined);
  const features = resolveUserFeatures(tier, overrides, isSystem);

  sendSuccess(res, 200, {
    user: formatUserResponse(user as unknown as UserResponseInput, {
      activeOrgRole, activeOrgName: organizationName, organization, organizations, tier, features,
    }),
  });
}, adminErrorMap);

/** PUT /users/:id — admin update. Org-admin restricted to own-org members. */
export const updateUserById = withController('Update user', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const id = req.params.id as string;

  // Org-admin authz pre-check (separate from the update so we can 403 early
  // without touching the DB record). System-admin can change org assignment;
  // org-admin can't.
  if (admin.isOrgAdmin) {
    const allowed = await userAdminService.hasMembershipInOrg(id, req.user!.organizationId!);
    if (!allowed) return sendError(res, 403, 'Forbidden: Can only update users in your organization');
    if (req.body.organizationId !== undefined) {
      return sendError(res, 403, 'Forbidden: Only system admins can change user organization');
    }
  }

  const { user, changes, organizationName, activeOrgRole } = await userAdminService.updateUserById(
    id,
    req.body,
    {
      isOrgAdmin: admin.isOrgAdmin,
      adminOrgId: admin.isOrgAdmin ? req.user!.organizationId : undefined,
      passwordMinLength: config.auth.passwordMinLength,
    },
  );

  logger.info('Update user by id', { id, admin: admin.adminType, by: req.user!.sub, changes });
  sendSuccess(
    res, 200,
    { user: formatUserResponse(user as unknown as UserResponseInput, { activeOrgRole, activeOrgName: organizationName }), changes },
    'User updated successfully',
  );
}, adminErrorMap);

/** DELETE /users/:id — admin delete with self-delete + owner protection. */
export const deleteUserById = withController('Delete user', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const { id } = req.params;
  if (id === req.user!.sub) {
    return sendError(res, 400, 'Cannot delete your own account through this endpoint');
  }

  if (admin.isOrgAdmin) {
    const allowed = await userAdminService.hasMembershipInOrg(id as string, req.user!.organizationId!);
    if (!allowed) return sendError(res, 403, 'Forbidden: Can only delete users in your organization');
  }

  await userAdminService.deleteUserById(id as string);

  logger.info('Delete user by id', { id, admin: admin.adminType, by: req.user!.sub });
  audit(req, 'admin.user.delete', { targetType: 'user', targetId: String(id) });
  sendSuccess(res, 200, undefined, 'User deleted successfully');
}, adminErrorMap);

/** PUT /users/:id/features — admin set feature-flag overrides on a user. */
export const updateUserFeatures = withController('Update user features', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const { id } = req.params;
  const { overrides } = req.body;

  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return sendError(res, 400, 'Request body must include an "overrides" object', 'VALIDATION_ERROR');
  }

  const invalidKeys = Object.keys(overrides).filter(k => !isValidFeatureFlag(k));
  if (invalidKeys.length > 0) {
    return sendError(res, 400, `Invalid feature flag(s): ${invalidKeys.join(', ')}`, 'VALIDATION_ERROR');
  }

  const nonBooleanKeys = Object.entries(overrides)
    .filter(([, v]) => typeof v !== 'boolean')
    .map(([k]) => k);
  if (nonBooleanKeys.length > 0) {
    return sendError(res, 400, `Override values must be booleans. Invalid: ${nonBooleanKeys.join(', ')}`, 'VALIDATION_ERROR');
  }

  if (admin.isOrgAdmin) {
    const allowed = await userAdminService.hasMembershipInOrg(id as string, req.user!.organizationId!);
    if (!allowed) return sendError(res, 403, 'Forbidden: Can only update users in your organization');
  }

  const { user, organizationName, activeOrgRole, tier: orgTier } = await userAdminService.updateFeatures(
    id as string, overrides as Record<string, boolean>,
  );

  const activeOrgId = user.lastActiveOrgId?.toString();
  const isSystem = activeOrgId === SYSTEM_ORG_ID;
  const features = resolveUserFeatures((orgTier as QuotaTier) || 'developer', overrides as Record<string, boolean>, isSystem);

  logger.info('Update user features', { id, admin: admin.adminType, by: req.user!.sub });
  sendSuccess(
    res, 200,
    { user: formatUserResponse(user as unknown as UserResponseInput, { activeOrgRole, activeOrgName: organizationName, tier: (orgTier as QuotaTier) || 'developer', features }) },
    'Feature overrides updated successfully',
  );
}, adminErrorMap);
