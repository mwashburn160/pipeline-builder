// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, resolveUserFeatures, isValidFeatureFlag, validateBulkArray, parsePaginationParams } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { formatUserResponse, toOverridesRecord, toUserResponseInput } from './user-profile.js';
import type { OrgSummary, OrgMembership } from './user-profile.js';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { requireAdminContext, withController } from '../helpers/controller-helper.js';
import {
  userAdminService,
  UA_USER_NOT_FOUND,
  UA_USERNAME_TAKEN,
  UA_EMAIL_TAKEN,
  UA_OWNER_HAS_ORGS,
  UA_ORG_NOT_FOUND,
  UA_SEAT_LIMIT,
  UA_CANNOT_CHANGE_OWNER,
  UA_ROLES_NEED_ORG,
  RL_ROLE_NOT_FOUND,
} from '../services/index.js';
import { adminCreateUserSchema, adminUpdateUserSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('user-admin-controller');

const adminErrorMap = {
  [UA_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [UA_USERNAME_TAKEN]: { status: 409, message: 'Username already in use' },
  [UA_EMAIL_TAKEN]: { status: 409, message: 'Email already in use' },
  [UA_OWNER_HAS_ORGS]: { status: 400, message: 'Cannot delete user who is an organization owner. Transfer ownership first.' },
  [UA_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [UA_SEAT_LIMIT]: { status: 403, message: 'Seat limit reached for the target organization — upgrade the plan or remove a member' },
  [UA_CANNOT_CHANGE_OWNER]: { status: 403, message: 'Cannot change the role of an organization owner. Transfer ownership first.' },
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

  const { offset, limit: limitNum } = parsePaginationParams(req.query);
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

    return formatUserResponse(toUserResponseInput(user), {
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

  if (activeOrgId) {
    const activeOrg = orgMap.get(activeOrgId);
    if (activeOrg) {
      organizationName = activeOrg.name;
      organization = { id: activeOrg._id.toString(), name: activeOrg.name, slug: activeOrg.slug };
      tier = (activeOrg.tier as QuotaTier) || 'developer';
    }
    const activeMembership = memberships.find(m => m.organizationId.toString() === activeOrgId);
    activeOrgRole = activeMembership?.role;
  }

  const overrides = toOverridesRecord(user.featureOverrides as Map<string, boolean> | undefined);
  const features = resolveUserFeatures(tier, overrides, (user as { isSuperAdmin?: boolean }).isSuperAdmin === true);

  sendSuccess(res, 200, {
    user: formatUserResponse(toUserResponseInput(user), {
      activeOrgRole, activeOrgName: organizationName, organization, organizations, tier, features,
    }),
  });
}, adminErrorMap);

/**
 * POST /users — create a user (system admin only).
 *
 * Sysadmin-only: org-admins are refused with 403 even though the route grants
 * `members:manage`. Creating a user out-of-band — optionally pre-flagged as a
 * platform super-admin and/or assigned to an existing org — is a
 * platform-operator concern, not an org-scoped one. The account is created
 * pre-verified (no email round-trip); password strength is enforced by the
 * schema and again by the User model pre-save hook.
 */
export const createUserByAdmin = withController('Create user', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;
  if (!admin.isSuperAdmin) return sendError(res, 403, 'Forbidden: system admin required to create users');

  const body = validateBody(adminCreateUserSchema, req.body, res);
  if (!body) return;

  const user = await userAdminService.createUser(body);

  logger.info('Create user by admin', { id: user.id, by: req.user!.sub, org: body.organizationId });
  audit(req, 'admin.user.create', { targetType: 'user', targetId: user.id, affectedOrgId: body.organizationId });
  sendSuccess(res, 201, { user }, 'User created');
}, {
  [UA_USERNAME_TAKEN]: { status: 409, message: 'A user with this username already exists' },
  [UA_EMAIL_TAKEN]: { status: 409, message: 'A user with this email already exists' },
  [UA_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [UA_ROLES_NEED_ORG]: { status: 400, message: 'Select an organization to assign roles' },
  [RL_ROLE_NOT_FOUND]: { status: 404, message: 'One or more selected roles were not found' },
});

/** PUT /users/:id — admin update. Org-admin restricted to own-org members. */
export const updateUserById = withController('Update user', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const id = req.params.id as string;

  // Validate body shape + types before any DB work. Rejects unknown fields
  // (`.strict()`) so an attacker can't slip in tokenVersion / isSuperAdmin
  // via the admin endpoint.
  const body = validateBody(adminUpdateUserSchema, req.body, res);
  if (!body) return;

  // Org-admin authz pre-check (separate from the update so we can 403 early
  // without touching the DB record). System-admin can change org assignment;
  // org-admin can't.
  if (admin.isOrgAdmin) {
    const allowed = await userAdminService.hasMembershipInOrg(id, req.user!.organizationId!);
    if (!allowed) return sendError(res, 403, 'Forbidden: Can only update users in your organization');
    if (body.organizationId !== undefined) {
      return sendError(res, 403, 'Forbidden: Only system admins can change user organization');
    }
    // Org-admin can't grant org ownership — that must go through transferOwnership
    // (which atomically demotes the current owner). Otherwise an org-admin could
    // self-escalate to owner via PUT /users/:id { role: 'owner' }.
    if (body.role === 'owner') {
      return sendError(res, 403, 'Forbidden: Ownership can only be changed via organization transfer');
    }
  }

  const { user, changes, organizationName, activeOrgRole } = await userAdminService.updateUserById(
    id,
    body,
    {
      isOrgAdmin: admin.isOrgAdmin,
      adminOrgId: admin.isOrgAdmin ? req.user!.organizationId : undefined,
      passwordMinLength: config.auth.passwordMinLength,
    },
  );

  logger.info('Update user by id', { id, admin: admin.adminType, by: req.user!.sub, changes });
  sendSuccess(
    res, 200,
    { user: formatUserResponse(toUserResponseInput(user), { activeOrgRole, activeOrgName: organizationName }), changes },
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

  // Capture the org context this delete affects BEFORE the user record
  // disappears — for sysadmins acting cross-tenant, this is the only field
  // that tells reviewers "what org was hit" when the actor's `orgId` is the
  // system org and the deleted user is in a different one. Falls back to
  // any membership found on the user; sysadmins deleting a user with no
  // memberships still get a record with affectedOrgId omitted.
  const affectedOrgId = admin.isOrgAdmin
    ? req.user!.organizationId!
    : await userAdminService.lookupPrimaryOrgId(id as string).catch(() => undefined);

  if (admin.isOrgAdmin) {
    const allowed = await userAdminService.hasMembershipInOrg(id as string, req.user!.organizationId!);
    if (!allowed) return sendError(res, 403, 'Forbidden: Can only delete users in your organization');
  }

  await userAdminService.deleteUserById(id as string);

  logger.info('Delete user by id', { id, admin: admin.adminType, by: req.user!.sub });
  audit(req, 'admin.user.delete', { targetType: 'user', targetId: String(id), affectedOrgId });
  sendSuccess(res, 200, undefined, 'User deleted successfully');
}, adminErrorMap);

/**
 * POST /users/bulk-delete — sysadmin bulk delete.
 *
 * Body: `{ ids: string[] }`. Returns per-id success/failure so the UI
 * can render a summary (deletes that 404'd, owners that can't be
 * removed, etc.) rather than refusing the whole batch on first error.
 *
 * Self-delete and the "owner has orgs" guard from the singular
 * endpoint apply per-id. Org admins are intentionally NOT allowed —
 * batch destructive ops on members is a sysadmin-only concern.
 */
export const bulkDeleteUsers = withController('Bulk delete users', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;
  if (admin.isOrgAdmin) {
    return sendError(res, 403, 'Forbidden: Bulk delete is sysadmin-only');
  }

  // Shared length/non-empty/cap validation via api-core. The per-item
  // shape check (string + non-empty) stays local — validateBulkArray
  // intentionally doesn't validate item shape.
  const arrCheck = validateBulkArray<string>((req.body as { ids?: unknown })?.ids, 'ids', 100);
  if ('error' in arrCheck) return sendError(res, 400, arrCheck.error);
  const ids = arrCheck.value;
  if (!ids.every((id) => typeof id === 'string' && id.length > 0)) {
    return sendError(res, 400, 'ids must be non-empty strings');
  }

  const results: Array<{ id: string; ok: boolean; error?: string; affectedOrgId?: string }> = [];

  for (const id of ids) {
    if (id === req.user!.sub) {
      results.push({ id, ok: false, error: 'Cannot delete your own account' });
      continue;
    }
    try {
      const affectedOrgId = await userAdminService.lookupPrimaryOrgId(id).catch(() => undefined);
      await userAdminService.deleteUserById(id);
      audit(req, 'admin.user.delete', { targetType: 'user', targetId: id, affectedOrgId, details: { bulk: true } });
      results.push({ id, ok: true, affectedOrgId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Map the named service errors to friendly messages; fall through to raw text.
      const mapped = adminErrorMap[msg as keyof typeof adminErrorMap];
      results.push({ id, ok: false, error: mapped?.message ?? msg });
    }
  }

  const summary = {
    requested: ids.length,
    deleted: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
  logger.info('Bulk delete users', { ...summary, by: req.user!.sub });
  sendSuccess(res, 200, { summary, results });
});

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

  const features = resolveUserFeatures(
    (orgTier as QuotaTier) || 'developer',
    overrides as Record<string, boolean>,
    (user as { isSuperAdmin?: boolean }).isSuperAdmin === true,
  );

  logger.info('Update user features', { id, admin: admin.adminType, by: req.user!.sub });
  sendSuccess(
    res, 200,
    { user: formatUserResponse(toUserResponseInput(user), { activeOrgRole, activeOrgName: organizationName, tier: (orgTier as QuotaTier) || 'developer', features }) },
    'Feature overrides updated successfully',
  );
}, adminErrorMap);
