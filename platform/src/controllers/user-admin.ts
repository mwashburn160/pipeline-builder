// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, resolveUserFeatures, isValidFeatureFlag, validateBulkArray, TIER_FEATURES, errorMessage } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { audit } from '../helpers/audit.js';
import { canManageOrgScope, isOrgAdmin, requireMemberManagementScope, withController } from '../helpers/controller-helper.js';
import { toOrgId } from '../helpers/org-id.js';
import { listPage, paginationMeta } from '../helpers/pagination.js';
import { formatUserResponse, toOverridesRecord, type OrgMembership, type OrgSummary } from '../helpers/user-response.js';
import { Organization } from '../models/index.js';
import { userAdminService } from '../services/index.js';
import { RL_ASSIGN_EXCEEDS_CEILING, RL_LAST_PRIVILEGED_MEMBER, RL_ROLE_NOT_FOUND } from '../services/roles-errors.js';
import { UA_USER_NOT_FOUND, UA_USERNAME_TAKEN, UA_EMAIL_TAKEN, UA_ORG_NOT_FOUND, UA_SEAT_LIMIT, UA_CANNOT_CHANGE_OWNER, UA_ROLES_NEED_ORG, USER_OWNER_HAS_ORGS } from '../services/user-errors.js';
import { adminCreateUserSchema, adminUpdateUserSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('user-admin-controller');

/**
 * Fetch an org's account-level purchased feature entitlements (add-on
 * bundles, e.g. `sso`/`audit_log`). Sourced the same way `utils/token.ts`
 * sources them for the real access token — off the membership's org
 * `featureEntitlements` — so admin-facing feature resolution matches the
 * feature set the user's own token actually carries. Returns undefined for a
 * missing org id / org so callers pass `undefined` through to
 * {@link resolveUserFeatures}'s optional `accountFeatures` field unchanged.
 */
async function orgFeatureEntitlements(orgId: string | undefined): Promise<string[] | undefined> {
  if (!orgId) return undefined;
  const org = await Organization.findById(toOrgId(orgId)).select('featureEntitlements').lean();
  return (org as { featureEntitlements?: string[] } | null)?.featureEntitlements;
}

/**
 * Resolve an org's ENTITLEMENT SET: the features it may enable via per-user
 * overrides without a system admin — its tier defaults (`TIER_FEATURES`) unioned
 * with its purchased account entitlements (`featureEntitlements`, the add-on
 * bundles). A feature OUTSIDE this set (e.g. `sso`/`audit_log` on a tier that
 * doesn't include them and with no purchase) is "entitlement-gated": enabling it
 * is a paid-feature bypass and is refused for org admins.
 */
async function orgEntitledFeatures(orgId: string): Promise<Set<string>> {
  const org = await Organization.findById(toOrgId(orgId)).select('tier featureEntitlements').lean();
  const tier = ((org as { tier?: string } | null)?.tier as QuotaTier) || 'developer';
  const accountFeatures = (org as { featureEntitlements?: string[] } | null)?.featureEntitlements ?? [];
  return new Set<string>([...(TIER_FEATURES[tier] ?? []), ...accountFeatures]);
}

const adminErrorMap = {
  [UA_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [UA_USERNAME_TAKEN]: { status: 409, message: 'Username already in use' },
  [UA_EMAIL_TAKEN]: { status: 409, message: 'Email already in use' },
  [USER_OWNER_HAS_ORGS]: { status: 400, message: 'Cannot delete user who is an organization owner. Transfer ownership first.' },
  [RL_LAST_PRIVILEGED_MEMBER]: { status: 409, message: 'Cannot delete the last member of an admin or super-admin role. Assign another member first.' },
  [UA_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [UA_SEAT_LIMIT]: { status: 403, message: 'Seat limit reached for the target organization — upgrade the plan or remove a member' },
  [UA_CANNOT_CHANGE_OWNER]: { status: 403, message: 'Cannot change the role of an organization owner. Transfer ownership first.' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot grant or revoke the Admin role without holding its permissions yourself.' },
};

/** Log label for the caller's scope. */
const adminType = (admin: { isSuperAdmin: boolean }) => (admin.isSuperAdmin ? 'system admin' : 'org-scoped');

/**
 * GET /users — list users.
 * System admin: all users (or scoped to a query org). Anyone else holding
 * `members:manage`: their active org, or one of its descendant teams.
 */
export const listAllUsers = withController('List users', async (req, res) => {
  const admin = requireMemberManagementScope(req, res);
  if (!admin) return;

  const { organizationId, role, search } = req.query;

  // Compute the user-id scope based on admin type + filters.
  let scopedUserIds: Types.ObjectId[] | null = null;
  let effectiveScopeOrgId: string | undefined;

  if (!admin.isSuperAdmin) {
    const requestedOrgId = typeof organizationId === 'string' && organizationId ? organizationId : admin.orgId!;
    if (!(await canManageOrgScope(req, requestedOrgId))) {
      return sendError(res, 403, 'Forbidden: Can only view users in your organization');
    }
    effectiveScopeOrgId = requestedOrgId;
    scopedUserIds = await userAdminService.getUserIdsInOrg(requestedOrgId);
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

  const { offset, limit: limitNum } = listPage(req.query);
  const { users, total, membershipsByUser, orgNameMap } = await userAdminService.list(
    scopedUserIds,
    { search: search as string | undefined },
    offset,
    limitNum,
  );

  const usersWithOrg = users.map(user => {
    const userMemberships = membershipsByUser.get(user._id.toString()) || [];
    const activeOrgId = user.lastActiveOrgId?.toString();
    const activeMembership = activeOrgId
      ? userMemberships.find(m => m.organizationId.toString() === activeOrgId)
      : undefined;

    return formatUserResponse(user, {
      activeOrgRole: activeMembership?.role,
      activeOrgName: activeOrgId ? orgNameMap.get(activeOrgId) || null : null,
    });
  });

  sendSuccess(res, 200, {
    users: usersWithOrg,
    pagination: paginationMeta(total, offset, limitNum),
  });
});

/** GET /users/:id — single user (sysadmin, or a member of the caller's org). */
export const getUserById = withController('Get user', async (req, res) => {
  const admin = requireMemberManagementScope(req, res);
  if (!admin) return;

  const { id } = req.params;
  const { user, memberships, orgMap } = await userAdminService.getByIdWithOrgs(id as string);

  // Org-scoped authz: target must be a member of the caller's org.
  if (!admin.isSuperAdmin) {
    const allowed = await userAdminService.hasMembershipInOrg(user._id, admin.orgId!);
    if (!allowed) return sendError(res, 403, 'Forbidden: Can only view users in your organization');
  }

  // A non-sysadmin org-admin must not learn the target's memberships in OTHER orgs
  // — scope the list to the admin's own org (authz above already confirmed the
  // target is a member of it). Sysadmins see the full cross-org list.
  const visibleMemberships = admin.isSuperAdmin
    ? memberships
    : memberships.filter(m => m.organizationId.toString() === admin.orgId);
  const organizations: OrgMembership[] = visibleMemberships.map(m => {
    const org = orgMap.get(m.organizationId.toString());
    return { id: m.organizationId.toString(), name: org?.name || 'Unknown', role: m.role };
  });

  // A non-sysadmin org-admin sees the member's summary (org id/name/slug, tier, role,
  // resolved features) STRICTLY as they exist in the ADMIN's own org — never the
  // member's (possibly foreign) lastActiveOrg — so no other org's details leak. The
  // target is guaranteed a member of the admin's org by the authz check above.
  const activeOrgId = admin.isSuperAdmin ? user.lastActiveOrgId?.toString() : admin.orgId;
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
  // Pass the active org's purchased account entitlements as the 4th arg so
  // purchased features (sso/audit_log) are reflected — mirrors token.ts and
  // keeps the admin view in lockstep with the user's real token.
  const accountFeatures = await orgFeatureEntitlements(activeOrgId);
  const features = resolveUserFeatures(tier, { overrides, isSuperAdmin: (user as { isSuperAdmin?: boolean }).isSuperAdmin === true, accountFeatures });

  sendSuccess(res, 200, {
    user: formatUserResponse(user, {
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
  const admin = requireMemberManagementScope(req, res);
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

/** PUT /users/:id — admin update. An org-scoped caller is restricted to own-org members. */
export const updateUserById = withController('Update user', async (req, res) => {
  const admin = requireMemberManagementScope(req, res);
  if (!admin) return;

  const id = req.params.id as string;

  // Validate body shape + types before any DB work. Rejects unknown fields
  // (`.strict()`) so an attacker can't slip in tokenVersion / isSuperAdmin
  // via the admin endpoint.
  const body = validateBody(adminUpdateUserSchema, req.body, res);
  if (!body) return;

  // Username, email and password belong to the ACCOUNT, which can span many
  // organizations — an admin of one of them must not be able to take it over
  // (set a password, or point the email at an address they control). Only a
  // platform admin changes sign-in details.
  if (!admin.isSuperAdmin && (body.username !== undefined || body.email !== undefined || body.password !== undefined)) {
    return sendError(res, 403, 'Forbidden: Only platform administrators can change a user\'s sign-in details', 'SIGN_IN_DETAILS_PLATFORM_ADMIN_ONLY');
  }

  // Ownership only moves through the organization transfer, which atomically
  // demotes the current owner — for every caller, a platform admin included.
  // Otherwise an org admin could self-escalate to owner, and a platform admin's
  // `role: 'owner'` would be recorded as a change that did nothing.
  if (body.role === 'owner') {
    return sendError(res, 403, 'Forbidden: Ownership can only be changed via organization transfer', 'OWNERSHIP_TRANSFER_REQUIRED');
  }

  // Org-admin authz pre-check (separate from the update so we can 403 early
  // without touching the DB record). System-admin can change org assignment;
  // org-admin can't.
  if (!admin.isSuperAdmin) {
    const allowed = await userAdminService.hasMembershipInOrg(id, admin.orgId!);
    if (!allowed) return sendError(res, 403, 'Forbidden: Can only update users in your organization');
    if (body.organizationId !== undefined) {
      return sendError(res, 403, 'Forbidden: Only system admins can change user organization');
    }
  }

  const { user, changes, organizationName, activeOrgRole } = await userAdminService.updateUserById(
    id,
    { ...body, role: body.role },
    {
      scopeOrgId: admin.orgId,
      actor: { isSuperAdmin: admin.isSuperAdmin, isOrgAdmin: isOrgAdmin(req), permissions: req.user!.permissions ?? [] },
    },
  );

  logger.info('Update user by id', { id, admin: adminType(admin), by: req.user!.sub, changes });

  // Audit privileged admin edits of ANOTHER user (role/email/password/org).
  // Only emit when something actually changed. `details.changes` is the field
  // NAMES array only — NEVER the new password (or any secret) value. For a
  // sysadmin acting cross-tenant, `affectedOrgId` records which org was hit:
  // the new org when the admin reassigned org, else the target's primary org.
  if (changes.length > 0) {
    const affectedOrgId = admin.orgId
      ?? body.organizationId ?? await userAdminService.lookupPrimaryOrgId(id).catch(() => undefined);
    audit(req, 'admin.user.update', { targetType: 'user', targetId: id, affectedOrgId, details: { changes } });
  }

  sendSuccess(
    res, 200,
    { user: formatUserResponse(user, { activeOrgRole, activeOrgName: organizationName }), changes },
    'User updated successfully',
  );
}, adminErrorMap);

/** DELETE /users/:id — admin delete with self-delete + owner protection. */
export const deleteUserById = withController('Delete user', async (req, res) => {
  const admin = requireMemberManagementScope(req, res);
  if (!admin) return;

  // Deleting removes the whole ACCOUNT from every organization it belongs to, so
  // it is a platform-admin action. An org admin removes a member from their own
  // organization instead (DELETE /organization/:id/members/:userId).
  if (!admin.isSuperAdmin) {
    return sendError(res, 403, 'Forbidden: Only platform administrators can delete an account. Remove the member from your organization instead.', 'ACCOUNT_DELETE_PLATFORM_ADMIN_ONLY');
  }

  const { id } = req.params;
  if (id === req.user!.sub) {
    return sendError(res, 400, 'Cannot delete your own account through this endpoint');
  }

  // Capture the org context this delete affects BEFORE the user record
  // disappears — the actor's `orgId` is the system org, so this is the only
  // field that tells reviewers "what org was hit". Omitted for a user with no
  // memberships.
  const affectedOrgId = await userAdminService.lookupPrimaryOrgId(id as string).catch(() => undefined);

  await userAdminService.deleteUserById(id as string);

  logger.info('Delete user by id', { id, admin: adminType(admin), by: req.user!.sub });
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
  const admin = requireMemberManagementScope(req, res);
  if (!admin) return;
  if (!admin.isSuperAdmin) {
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
      const msg = errorMessage(err);
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
  const admin = requireMemberManagementScope(req, res);
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

  if (!admin.isSuperAdmin) {
    const allowed = await userAdminService.hasMembershipInOrg(id as string, admin.orgId!);
    if (!allowed) return sendError(res, 403, 'Forbidden: Can only update users in your organization');

    // SECURITY: an org admin may only override-ENABLE features already covered by
    // their org's entitlements (tier defaults ∪ purchased add-on bundles).
    // Enabling an entitlement-gated feature (e.g. sso/audit_log with no purchase)
    // would (1) bypass billing and (2) — because `featureOverrides` is a GLOBAL
    // User field — leak the grant into the target's OTHER orgs (cross-tenant).
    // Only a system admin may override-enable a gated feature. Disabling (`false`)
    // is always allowed (removing a feature is never an escalation).
    const entitled = await orgEntitledFeatures(admin.orgId!);
    const forbidden = Object.entries(overrides as Record<string, unknown>)
      .filter(([k, v]) => v === true && !entitled.has(k))
      .map(([k]) => k);
    if (forbidden.length > 0) {
      return sendError(
        res, 403,
        `Forbidden: enabling entitlement-gated feature(s) requires a system admin or an active entitlement: ${forbidden.join(', ')}`,
        'ENTITLEMENT_REQUIRED',
      );
    }
  }

  const { user, organizationName, activeOrgRole, tier: orgTier } = await userAdminService.updateFeatures(
    id as string, overrides as Record<string, boolean>,
  );

  // Include the active org's purchased account entitlements (accountFeatures) so the
  // updated-features response reflects sso/audit_log the same way the user's
  // real token does — see token.ts.
  const accountFeatures = await orgFeatureEntitlements(
    (user as { lastActiveOrgId?: { toString(): string } }).lastActiveOrgId?.toString(),
  );
  const features = resolveUserFeatures(
    (orgTier as QuotaTier) || 'developer',
    {
      overrides: overrides as Record<string, boolean>,
      isSuperAdmin: (user as { isSuperAdmin?: boolean }).isSuperAdmin === true,
      accountFeatures,
    },
  );

  logger.info('Update user features', { id, admin: adminType(admin), by: req.user!.sub });

  // Audit the sysadmin/org-admin feature-override edit AFTER it succeeds. This is
  // a privileged capability grant/revoke on another user, so it must leave a
  // trail. `details.features` is the field NAMES touched only (no values needed —
  // they're booleans, but names are the forensic signal). `affectedOrgId` is the
  // admin's org for an org-admin, else the target user's active org.
  const featuresAffectedOrgId = admin.orgId
    ?? (user as { lastActiveOrgId?: { toString(): string } }).lastActiveOrgId?.toString();
  audit(req, 'admin.user.features.update', {
    targetType: 'user',
    targetId: id as string,
    affectedOrgId: featuresAffectedOrgId,
    details: { features: Object.keys(overrides as Record<string, boolean>) },
  });

  sendSuccess(
    res, 200,
    { user: formatUserResponse(user, { activeOrgRole, activeOrgName: organizationName, tier: (orgTier as QuotaTier) || 'developer', features }) },
    'Feature overrides updated successfully',
  );
}, adminErrorMap);
