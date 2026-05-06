// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { toOrgId } from '../helpers/controller-helper';
import { User, Organization, UserOrganization } from '../models';

const logger = createLogger('UserAdminService');

export const UA_USER_NOT_FOUND = 'UA_USER_NOT_FOUND';
export const UA_USERNAME_TAKEN = 'UA_USERNAME_TAKEN';
export const UA_EMAIL_TAKEN = 'UA_EMAIL_TAKEN';
export const UA_OWNER_HAS_ORGS = 'UA_OWNER_HAS_ORGS';
export const UA_ORG_NOT_FOUND = 'UA_ORG_NOT_FOUND';

interface ListFilter {
  /** Restrict to a specific org (system-admin only); narrows the userId set. */
  scopedOrgId?: string;
  /** Optional role filter — applied within the org scope. */
  role?: string;
  /** Free-text search on username/email. */
  search?: string;
}

interface ListResult {
  users: Array<Record<string, unknown>>;
  total: number;
  /** Per-user memberships, indexed by userId-string. */
  membershipsByUser: Map<string, Array<{ organizationId: Types.ObjectId | string; role: string }>>;
  /** Org-id → name for response shaping. */
  orgNameMap: Map<string, string>;
}

class UserAdminService {
  /**
   * Resolve user IDs that are members of an org. Used by the admin list to
   * compute the org-scope filter; org-admin callers always pass their own
   * org, system-admins pass an arbitrary one or omit.
   */
  async getUserIdsInOrg(orgId: string): Promise<Types.ObjectId[]> {
    const ids = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true }).distinct('userId');
    return ids as Types.ObjectId[];
  }

  /** User IDs that hold a specific role within an org — for the role filter. */
  async getUserIdsByRoleInOrg(orgId: string, role: string): Promise<Types.ObjectId[]> {
    const ids = await UserOrganization.find({ organizationId: toOrgId(orgId), role, isActive: true }).distinct('userId');
    return ids as Types.ObjectId[];
  }

  /**
   * Run the listing query + fetch all per-user memberships + resolve org
   * names — three DB calls, returns the materials for the controller's
   * response shaping. Caller already computed the user-id scope.
   */
  async list(scopedUserIds: Types.ObjectId[] | null, filter: ListFilter, offset: number, limit: number): Promise<ListResult> {
    const mongoFilter: Record<string, unknown> = {};
    if (scopedUserIds !== null) mongoFilter._id = { $in: scopedUserIds };
    if (filter.search) {
      mongoFilter.$or = [
        { username: { $regex: filter.search, $options: 'i' } },
        { email: { $regex: filter.search, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(mongoFilter)
        .select('_id username email isEmailVerified lastActiveOrgId createdAt updatedAt')
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      User.countDocuments(mongoFilter),
    ]);

    const userIds = users.map(u => u._id);
    const allMemberships = userIds.length > 0
      ? await UserOrganization.find({ userId: { $in: userIds } }).lean()
      : [];

    const membershipsByUser = new Map<string, Array<{ organizationId: Types.ObjectId | string; role: string }>>();
    for (const m of allMemberships) {
      const uid = m.userId.toString();
      if (!membershipsByUser.has(uid)) membershipsByUser.set(uid, []);
      membershipsByUser.get(uid)!.push(m);
    }

    const allOrgIds = [...new Set(allMemberships.map(m => m.organizationId.toString()))];
    const orgs = allOrgIds.length > 0
      ? await Organization.find({ _id: { $in: allOrgIds } }).select('_id name').lean()
      : [];
    const orgNameMap = new Map(orgs.map(o => [o._id.toString(), o.name]));

    return { users: users as unknown as Array<Record<string, unknown>>, total, membershipsByUser, orgNameMap };
  }

  /**
   * Return the full user record (for org-admin selection of fields callers
   * may need) plus their memberships and org map for response shaping.
   * Throws UA_USER_NOT_FOUND if the user is gone.
   */
  async getByIdWithOrgs(id: string) {
    const user = await User.findById(id)
      .select('_id username email isEmailVerified lastActiveOrgId featureOverrides createdAt updatedAt')
      .lean();
    if (!user) throw new Error(UA_USER_NOT_FOUND);

    const memberships = await UserOrganization.find({ userId: user._id }).lean();
    const orgIds = memberships.map(m => m.organizationId);
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name slug tier').lean()
      : [];
    const orgMap = new Map(orgs.map(o => [o._id.toString(), o]));

    return { user, memberships, orgMap };
  }

  /**
   * Verify a user is an active member of an org — used for org-admin auth
   * checks ("can this org-admin see this user?"). Returns true on match.
   */
  async hasMembershipInOrg(userId: string | Types.ObjectId, orgId: string): Promise<boolean> {
    const m = await UserOrganization.findOne({
      userId, organizationId: toOrgId(orgId), isActive: true,
    });
    return !!m;
  }

  /**
   * Mutating update of a user record: username, email, password, role-in-org,
   * and (system-admin only) organization assignment. Returns the saved
   * user + the change list. Validation errors throw UA_USERNAME_TAKEN /
   * UA_EMAIL_TAKEN / UA_USER_NOT_FOUND / UA_ORG_NOT_FOUND.
   */
  async updateUserById(
    id: string,
    body: {
      username?: string;
      email?: string;
      role?: string;
      organizationId?: string | null;
      password?: string;
    },
    options: {
      isOrgAdmin: boolean;
      adminOrgId?: string;
      passwordMinLength: number;
    },
  ) {
    const user = await User.findById(id).select('+password +tokenVersion');
    if (!user) throw new Error(UA_USER_NOT_FOUND);

    const changes: string[] = [];

    if (body.username !== undefined) {
      const exists = await User.findOne({
        username: body.username.trim().toLowerCase(),
        _id: { $ne: new Types.ObjectId(id) },
      });
      if (exists) throw new Error(UA_USERNAME_TAKEN);
      user.username = body.username.trim().toLowerCase();
      changes.push('username');
    }

    if (body.email !== undefined) {
      const exists = await User.findOne({
        email: body.email.trim().toLowerCase(),
        _id: { $ne: new Types.ObjectId(id) },
      });
      if (exists) throw new Error(UA_EMAIL_TAKEN);
      user.email = body.email.trim().toLowerCase();
      user.isEmailVerified = false;
      changes.push('email');
    }

    // Role applies to the user's membership in a specific org. Org-admins
    // change the role in their own org; system-admins target the supplied
    // organizationId or fall back to the user's last-active org.
    if (body.role !== undefined && ['owner', 'admin', 'member'].includes(body.role)) {
      const targetOrgId = options.isOrgAdmin
        ? options.adminOrgId
        : (body.organizationId || user.lastActiveOrgId?.toString());
      if (targetOrgId) {
        await UserOrganization.updateOne(
          { userId: user._id, organizationId: toOrgId(targetOrgId) },
          { $set: { role: body.role } },
        );
        changes.push('role');
      }
    }

    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < options.passwordMinLength) {
        throw new Error(`Password must be at least ${options.passwordMinLength} characters`);
      }
      user.password = body.password;
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      changes.push('password');
    }

    // Organization assignment is system-admin-only. Empty string or null
    // removes the user from every org; otherwise we ensure a membership
    // exists in the target org and update lastActiveOrgId.
    if (!options.isOrgAdmin && body.organizationId !== undefined) {
      if (body.organizationId === null || body.organizationId === '') {
        await UserOrganization.deleteMany({ userId: user._id });
        user.lastActiveOrgId = undefined;
        changes.push('organizationId (removed)');
      } else {
        const newOrg = await Organization.findById(body.organizationId);
        if (!newOrg) throw new Error(UA_ORG_NOT_FOUND);
        const existingMembership = await UserOrganization.findOne({
          userId: user._id, organizationId: toOrgId(body.organizationId),
        });
        if (!existingMembership) {
          await UserOrganization.create({
            userId: user._id, organizationId: toOrgId(body.organizationId), role: 'member',
          });
        }
        user.lastActiveOrgId = body.organizationId as unknown as Types.ObjectId;
        changes.push('organizationId');
      }
    }

    await user.save();

    // Re-fetch the active org name + role for response shaping.
    const activeOrgId = user.lastActiveOrgId?.toString();
    let organizationName: string | null = null;
    let activeOrgRole: string | undefined;
    if (activeOrgId) {
      const [org, membership] = await Promise.all([
        Organization.findById(activeOrgId).select('name').lean(),
        UserOrganization.findOne({ userId: user._id, organizationId: activeOrgId, isActive: true }).lean(),
      ]);
      organizationName = org?.name || null;
      activeOrgRole = membership?.role;
    }

    return { user, changes, organizationName, activeOrgRole };
  }

  /**
   * Delete a user + their memberships. Refuses if the user is an org owner
   * (transfer first). Throws UA_USER_NOT_FOUND or UA_OWNER_HAS_ORGS.
   * Caller is responsible for the self-delete check.
   */
  async deleteUserById(id: string): Promise<void> {
    const user = await User.findById(id);
    if (!user) throw new Error(UA_USER_NOT_FOUND);

    const ownerCount = await UserOrganization.countDocuments({ userId: user._id, role: 'owner' });
    if (ownerCount > 0) throw new Error(UA_OWNER_HAS_ORGS);

    await UserOrganization.deleteMany({ userId: user._id });
    await User.findByIdAndDelete(id);
    logger.info('User deleted by admin', { userId: id });
  }

  /**
   * Update a user's `featureOverrides` Map and return the saved user +
   * active-org info needed to compute resolved features for the response.
   * Throws UA_USER_NOT_FOUND.
   */
  async updateFeatures(id: string, overrides: Record<string, boolean>) {
    const user = await User.findById(id).select('_id username email isEmailVerified lastActiveOrgId featureOverrides');
    if (!user) throw new Error(UA_USER_NOT_FOUND);

    user.featureOverrides = new Map(Object.entries(overrides));
    await user.save();

    let organizationName: string | null = null;
    let activeOrgRole: string | undefined;
    let tier: string | undefined;
    const activeOrgId = user.lastActiveOrgId?.toString();
    if (activeOrgId) {
      const [org, membership] = await Promise.all([
        Organization.findById(activeOrgId).select('name tier').lean(),
        UserOrganization.findOne({ userId: user._id, organizationId: activeOrgId, isActive: true }).lean(),
      ]);
      organizationName = org?.name || null;
      tier = org?.tier;
      activeOrgRole = membership?.role;
    }

    return { user, organizationName, activeOrgRole, tier };
  }
}

export const userAdminService = new UserAdminService();
