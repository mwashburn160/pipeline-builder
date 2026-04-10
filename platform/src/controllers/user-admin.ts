// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, resolveUserFeatures, isValidFeatureFlag, SYSTEM_ORG_ID } from '@mwashburn160/api-core';
import type { QuotaTier } from '@mwashburn160/api-core';
import { Types } from 'mongoose';
import { config } from '../config';
import { formatUserResponse, toOverridesRecord } from './user-profile';
import type { OrgSummary, OrgMembership } from './user-profile';
import { audit } from '../helpers/audit';
import { requireAdminContext, toOrgId, withController } from '../helpers/controller-helper';
import { User, Organization, UserOrganization } from '../models';
import { parsePagination } from '../utils/pagination';

const logger = createLogger('UserAdminController');

// Admin User Management Endpoints

/**
 * List all users (System Admin) or organization users (Org Admin)
 * GET /users
 */
export const listAllUsers = withController('List users', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const { organizationId, role, search } = req.query;

  const filter: Record<string, unknown> = {};

  // Determine which user IDs to scope to based on org membership
  let scopedUserIds: Types.ObjectId[] | null = null;

  if (admin.isOrgAdmin) {
    const reqOrgId = req.user!.organizationId!;
    if (organizationId && organizationId !== reqOrgId) {
      return sendError(res, 403, 'Forbidden: Can only view users in your organization');
    }
    const memberships = await UserOrganization.find({ organizationId: toOrgId(reqOrgId), isActive: true }).distinct('userId');
    scopedUserIds = memberships as Types.ObjectId[];
  } else if (organizationId) {
    const memberships = await UserOrganization.find({ organizationId: toOrgId(organizationId as string), isActive: true }).distinct('userId');
    scopedUserIds = memberships as Types.ObjectId[];
  }

  if (scopedUserIds !== null) {
    filter._id = { $in: scopedUserIds };
  }

  if (search) {
    filter.$or = [
      { username: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }

  const { offset, limit: limitNum } = parsePagination(req.query.offset, req.query.limit);

  // If role filter is specified and we have an org context, further scope user IDs by role
  if (role && ['owner', 'admin', 'member'].includes(role as string)) {
    const orgIdForRole = admin.isOrgAdmin ? req.user!.organizationId : (organizationId as string | undefined);
    if (orgIdForRole) {
      const roleMembers = await UserOrganization.find({ organizationId: toOrgId(orgIdForRole), role, isActive: true }).distinct('userId');
      if (scopedUserIds !== null) {
        // Intersect with existing scoped IDs
        const roleSet = new Set(roleMembers.map((id: Types.ObjectId) => id.toString()));
        filter._id = { $in: scopedUserIds.filter(id => roleSet.has(id.toString())) };
      } else {
        filter._id = { $in: roleMembers };
      }
    }
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select('_id username email isEmailVerified lastActiveOrgId createdAt updatedAt')
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limitNum)
      .lean(),
    User.countDocuments(filter),
  ]);

  // Get active org info for each user
  const userIds = users.map(u => u._id);
  const allMemberships = userIds.length > 0
    ? await UserOrganization.find({ userId: { $in: userIds } }).lean()
    : [];

  // Build a map of userId -> memberships
  const membershipsByUser = new Map<string, typeof allMemberships>();
  for (const m of allMemberships) {
    const uid = m.userId.toString();
    if (!membershipsByUser.has(uid)) membershipsByUser.set(uid, []);
    membershipsByUser.get(uid)!.push(m);
  }

  // Collect all org IDs for name resolution
  const allOrgIds = [...new Set(allMemberships.map(m => m.organizationId.toString()))];
  const orgs = allOrgIds.length > 0
    ? await Organization.find({ _id: { $in: allOrgIds } }).select('_id name').lean()
    : [];
  const orgMap = new Map(orgs.map(o => [o._id.toString(), o.name]));

  const usersWithOrg = users.map(user => {
    const userMemberships = membershipsByUser.get(user._id.toString()) || [];
    const activeOrgId = user.lastActiveOrgId?.toString();
    const activeMembership = activeOrgId
      ? userMemberships.find(m => m.organizationId.toString() === activeOrgId)
      : undefined;

    return formatUserResponse(user, {
      activeOrgRole: activeMembership?.role,
      activeOrgName: activeOrgId ? orgMap.get(activeOrgId) || null : null,
    });
  });

  sendSuccess(res, 200, {
    users: usersWithOrg,
    pagination: { total, offset, limit: limitNum, hasMore: offset + limitNum < total },
  });
});

/**
 * Get user by ID (System Admin or Org Admin for their org members)
 * GET /users/:id
 */
export const getUserById = withController('Get user', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const { id } = req.params;

  const user = await User.findById(id)
    .select('_id username email isEmailVerified lastActiveOrgId featureOverrides createdAt updatedAt')
    .lean();

  if (!user) {
    return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
  }

  // For org admins, verify the target user belongs to the admin's org
  if (admin.isOrgAdmin) {
    const membership = await UserOrganization.findOne({
      userId: user._id,
      organizationId: toOrgId(req.user!.organizationId!),
      isActive: true,
    });
    if (!membership) {
      return sendError(res, 403, 'Forbidden: Can only view users in your organization');
    }
  }

  // Get all memberships for the user
  const memberships = await UserOrganization.find({ userId: user._id }).lean();
  const orgIds = memberships.map(m => m.organizationId);

  const orgs = orgIds.length > 0
    ? await Organization.find({ _id: { $in: orgIds } }).select('_id name slug tier').lean()
    : [];
  const orgMap = new Map(orgs.map(o => [o._id.toString(), o]));

  const organizations: OrgMembership[] = memberships.map(m => {
    const org = orgMap.get(m.organizationId.toString());
    return {
      id: m.organizationId.toString(),
      name: org?.name || 'Unknown',
      role: m.role,
    };
  });

  // Resolve active org details
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
    user: formatUserResponse(user, {
      activeOrgRole,
      activeOrgName: organizationName,
      organization,
      organizations,
      tier,
      features,
    }),
  });
});

/**
 * Update user by ID (System Admin or Org Admin for their org members)
 * PUT /users/:id
 */
export const updateUserById = withController('Update user', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const id = req.params.id as string;
  const { username, email, role, organizationId, password } = req.body;

  const user = await User.findById(id).select('+password +tokenVersion');
  if (!user) {
    return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
  }

  // For org admins, verify the target user belongs to the admin's org
  if (admin.isOrgAdmin) {
    const membership = await UserOrganization.findOne({
      userId: user._id,
      organizationId: toOrgId(req.user!.organizationId!),
      isActive: true,
    });
    if (!membership) {
      return sendError(res, 403, 'Forbidden: Can only update users in your organization');
    }
  }

  if (admin.isOrgAdmin && organizationId !== undefined) {
    return sendError(res, 403, 'Forbidden: Only system admins can change user organization');
  }

  const changes: string[] = [];

  if (username !== undefined) {
    const existing = await User.findOne({
      username: username.trim().toLowerCase(),
      _id: { $ne: new Types.ObjectId(id) },
    });
    if (existing) {
      return sendError(res, 409, 'Username already in use', 'USERNAME_TAKEN');
    }
    user.username = username.trim().toLowerCase();
    changes.push('username');
  }

  if (email !== undefined) {
    const existing = await User.findOne({
      email: email.trim().toLowerCase(),
      _id: { $ne: new Types.ObjectId(id) },
    });
    if (existing) {
      return sendError(res, 409, 'Email already in use', 'EMAIL_TAKEN');
    }
    user.email = email.trim().toLowerCase();
    user.isEmailVerified = false;
    changes.push('email');
  }

  // Role changes now apply to the user's membership in a specific org
  if (role !== undefined && ['owner', 'admin', 'member'].includes(role)) {
    const targetOrgId = admin.isOrgAdmin ? req.user!.organizationId : (organizationId || user.lastActiveOrgId?.toString());
    if (targetOrgId) {
      await UserOrganization.updateOne(
        { userId: user._id, organizationId: toOrgId(targetOrgId) },
        { $set: { role } },
      );
      changes.push('role');
    }
  }

  if (password !== undefined) {
    if (password.length < config.auth.passwordMinLength) {
      return sendError(res, 400, `Password must be at least ${config.auth.passwordMinLength} characters`, 'INVALID_PASSWORD');
    }
    user.password = password;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    changes.push('password');
  }

  // Organization assignment: create/remove UserOrganization records
  if (admin.isSysAdmin && organizationId !== undefined) {
    if (organizationId === null || organizationId === '') {
      // Remove user from all organizations
      await UserOrganization.deleteMany({ userId: user._id });
      user.lastActiveOrgId = undefined;
      changes.push('organizationId (removed)');
    } else {
      const newOrg = await Organization.findById(organizationId);
      if (!newOrg) {
        return sendError(res, 404, 'Organization not found');
      }

      // Check if already a member of the target org
      const existingMembership = await UserOrganization.findOne({
        userId: user._id,
        organizationId: toOrgId(organizationId),
      });

      if (!existingMembership) {
        await UserOrganization.create({
          userId: user._id,
          organizationId: toOrgId(organizationId),
          role: 'member',
        });
      }

      user.lastActiveOrgId = organizationId;
      changes.push('organizationId');
    }
  }

  await user.save();

  logger.info(`[UPDATE USER BY ID] User ${id} updated by ${admin.adminType} ${req.user!.sub}. Changes: ${changes.join(', ')}`);

  // Get active org info for response
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

  sendSuccess(res, 200, { user: formatUserResponse(user, { activeOrgRole, activeOrgName: organizationName }), changes }, 'User updated successfully');
});

/**
 * Delete user by ID (System Admin or Org Admin for their org members)
 * DELETE /users/:id
 */
export const deleteUserById = withController('Delete user', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const { id } = req.params;

  if (id === req.user!.sub) {
    return sendError(res, 400, 'Cannot delete your own account through this endpoint');
  }

  const user = await User.findById(id);
  if (!user) {
    return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
  }

  // For org admins, verify the target user belongs to the admin's org
  if (admin.isOrgAdmin) {
    const membership = await UserOrganization.findOne({
      userId: user._id,
      organizationId: toOrgId(req.user!.organizationId!),
      isActive: true,
    });
    if (!membership) {
      return sendError(res, 403, 'Forbidden: Can only delete users in your organization');
    }
  }

  // Prevent deleting users who own organizations
  const ownerCount = await UserOrganization.countDocuments({ userId: user._id, role: 'owner' });
  if (ownerCount > 0) {
    return sendError(res, 400, 'Cannot delete user who is an organization owner. Transfer ownership first.');
  }

  // Remove all org memberships for this user
  await UserOrganization.deleteMany({ userId: user._id });

  await User.findByIdAndDelete(id);

  logger.info(`[DELETE USER BY ID] User ${id} deleted by ${admin.adminType} ${req.user!.sub}`);
  audit(req, 'admin.user.delete', { targetType: 'user', targetId: String(id) });

  sendSuccess(res, 200, undefined, 'User deleted successfully');
});

/**
 * Update feature overrides for a user (Admin only)
 * PUT /users/:id/features
 */
export const updateUserFeatures = withController('Update user features', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  const { id } = req.params;
  const { overrides } = req.body;

  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return sendError(res, 400, 'Request body must include an "overrides" object', 'VALIDATION_ERROR');
  }

  // Validate all keys are valid feature flags
  const invalidKeys = Object.keys(overrides).filter(k => !isValidFeatureFlag(k));
  if (invalidKeys.length > 0) {
    return sendError(res, 400, `Invalid feature flag(s): ${invalidKeys.join(', ')}`, 'VALIDATION_ERROR');
  }

  // Validate all values are booleans
  const nonBooleanKeys = Object.entries(overrides).filter(([, v]) => typeof v !== 'boolean').map(([k]) => k);
  if (nonBooleanKeys.length > 0) {
    return sendError(res, 400, `Override values must be booleans. Invalid: ${nonBooleanKeys.join(', ')}`, 'VALIDATION_ERROR');
  }

  const user = await User.findById(id).select('_id username email isEmailVerified lastActiveOrgId featureOverrides');
  if (!user) {
    return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
  }

  // Org admin can only update users in their org
  if (admin.isOrgAdmin) {
    const membership = await UserOrganization.findOne({
      userId: user._id,
      organizationId: toOrgId(req.user!.organizationId!),
      isActive: true,
    });
    if (!membership) {
      return sendError(res, 403, 'Forbidden: Can only update users in your organization');
    }
  }

  // Apply overrides
  user.featureOverrides = new Map(Object.entries(overrides as Record<string, boolean>));
  await user.save();

  // Resolve features for response
  let tier: QuotaTier = 'developer';
  let isSystem = false;
  let organizationName: string | null = null;
  let activeOrgRole: string | undefined;

  const activeOrgId = user.lastActiveOrgId?.toString();
  if (activeOrgId) {
    const [org, membership] = await Promise.all([
      Organization.findById(activeOrgId).select('name tier').lean(),
      UserOrganization.findOne({ userId: user._id, organizationId: activeOrgId, isActive: true }).lean(),
    ]);
    organizationName = org?.name || null;
    tier = (org?.tier as QuotaTier) || 'developer';
    isSystem = activeOrgId === SYSTEM_ORG_ID;
    activeOrgRole = membership?.role;
  }

  const features = resolveUserFeatures(tier, overrides as Record<string, boolean>, isSystem);

  logger.info(`[UPDATE USER FEATURES] User ${id} features updated by ${admin.adminType} ${req.user!.sub}`);

  sendSuccess(res, 200, {
    user: formatUserResponse(user, { activeOrgRole, activeOrgName: organizationName, tier, features }),
  }, 'Feature overrides updated successfully');
});
