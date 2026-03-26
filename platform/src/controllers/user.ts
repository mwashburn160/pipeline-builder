import { createLogger, sendError, sendSuccess, resolveUserFeatures, isValidFeatureFlag, SYSTEM_ORG_ID } from '@mwashburn160/api-core';
import type { FeatureFlag, QuotaTier } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { config } from '../config';
import { audit } from '../helpers/audit';
import { requireAuthUserId, requireAdminContext } from '../helpers/controller-helper';
import { User, Organization } from '../models';
import { parsePagination } from '../utils/pagination';
import { issueTokens } from '../utils/token';
import { validateBody, updateProfileSchema, changePasswordSchema } from '../utils/validation';

const logger = createLogger('UserController');

// Org Lookup Helper

/**
 * Look up an organization's display name by ID.
 * @param orgId - Organization ID (or undefined)
 * @returns Organization name, or null if not found
 */
async function getOrgName(orgId: string | undefined): Promise<string | null> {
  if (!orgId) return null;
  const org = await Organization.findById(orgId).select('name').lean();
  return org?.name || null;
}

/** Fields required to build a user API response. */
interface UserResponseInput {
  _id: Types.ObjectId;
  username: string;
  email: string;
  role: string;
  isEmailVerified: boolean;
  organizationId?: Types.ObjectId | string;
  featureOverrides?: Map<string, boolean> | Record<string, boolean>;
  createdAt?: Date;
  updatedAt?: Date;
  tokenVersion?: number;
}

/** Compact organization summary included in user responses. */
interface OrgSummary {
  id: string;
  name: string;
  slug: string;
}

/** Convert Mongoose Map or plain object to Record<string, boolean>. */
function toOverridesRecord(overrides?: Map<string, boolean> | Record<string, boolean>): Record<string, boolean> | undefined {
  if (!overrides) return undefined;
  if (overrides instanceof Map) return Object.fromEntries(overrides);
  return overrides;
}

/**
 * Build a standardized user response object for API output.
 * @param user - User fields from DB
 * @param organizationName - Resolved org name (or null)
 * @param organization - Optional detailed org summary
 * @param extra - Optional tier and resolved features
 */
function formatUserResponse(
  user: UserResponseInput,
  organizationName: string | null,
  organization?: OrgSummary,
  extra?: { tier?: QuotaTier; features?: FeatureFlag[] },
) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    isEmailVerified: user.isEmailVerified,
    organizationId: user.organizationId?.toString() || null,
    organizationName,
    ...(organization && { organization }),
    ...(extra?.tier && { tier: extra.tier }),
    ...(extra?.features && { features: extra.features }),
    ...(user.featureOverrides && { featureOverrides: toOverridesRecord(user.featureOverrides) }),
    ...(user.createdAt && { createdAt: user.createdAt }),
    ...(user.updatedAt && { updatedAt: user.updatedAt }),
    ...(user.tokenVersion !== undefined && { tokenVersion: user.tokenVersion }),
  };
}

// User Profile Endpoints

/**
 * Get current user profile
 * GET /user/profile
 */
export async function getUser(req: Request, res: Response): Promise<void> {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  try {
    const user = await User.findById(userId)
      .select('_id username email role isEmailVerified organizationId featureOverrides tokenVersion')
      .lean();

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    // Resolve org tier and features
    let organizationName: string | null = null;
    let tier: QuotaTier = 'developer';
    let isSystem = false;

    if (user.organizationId) {
      const org = await Organization.findById(user.organizationId).select('name tier').lean();
      organizationName = org?.name || null;
      tier = (org?.tier as QuotaTier) || 'developer';
      isSystem = user.organizationId.toString() === SYSTEM_ORG_ID;
    }

    const overrides = toOverridesRecord(user.featureOverrides as Map<string, boolean> | undefined);
    const features = resolveUserFeatures(tier, overrides, isSystem);

    sendSuccess(res, 200, { user: formatUserResponse(user, organizationName, undefined, { tier, features }) });
  } catch (error) {
    logger.error('[GET USER] Error:', error);
    return sendError(res, 500, 'Failed to fetch user');
  }
}

/**
 * Update user profile
 * PATCH /user/profile
 */
export async function updateUser(req: Request, res: Response): Promise<void> {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  try {
    const body = validateBody(updateProfileSchema, req.body, res);
    if (!body) return;

    const updates: Partial<{ username: string; email: string; isEmailVerified: boolean }> = {};

    if (body.username) updates.username = body.username.trim().toLowerCase();
    if (body.email) updates.email = body.email.trim().toLowerCase();

    if (updates.email) {
      const existing = await User.findOne({
        email: updates.email,
        _id: { $ne: new Types.ObjectId(userId) },
      });
      if (existing) {
        return sendError(res, 409, 'Email already in use', 'EMAIL_TAKEN');
      }
      updates.isEmailVerified = false;
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { returnDocument: 'after', runValidators: true },
    ).lean();

    if (!updatedUser) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const organizationName = await getOrgName(updatedUser.organizationId?.toString());

    logger.info(`[UPDATE USER] Success for user: ${userId}`);

    sendSuccess(res, 200, { user: formatUserResponse(updatedUser, organizationName) });
  } catch (error) {
    logger.error('[UPDATE USER] Error:', error);
    return sendError(res, 500, 'Update failed');
  }
}

/**
 * Delete user account
 * DELETE /user/account
 */
export async function deleteUser(req: Request, res: Response): Promise<void> {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  try {
    const result = await User.findByIdAndDelete(userId);

    if (!result) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    logger.info(`[DELETE USER] Account deleted: ${userId}`);
    audit(req, 'user.delete', { targetType: 'user', targetId: userId });

    sendSuccess(res, 200, undefined, 'Account successfully deleted');
  } catch (error) {
    logger.error('[DELETE USER] Error:', error);
    return sendError(res, 500, 'Delete failed');
  }
}

/**
 * Change user password
 * POST /user/change-password
 */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  try {
    const body = validateBody(changePasswordSchema, req.body, res);
    if (!body) return;

    const { currentPassword, newPassword } = body;

    const user = await User.findById(userId).select('+password +tokenVersion');
    if (!user || !user.password) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return sendError(res, 401, 'Current password incorrect', 'INVALID_CREDENTIALS');
    }

    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();

    logger.info(`[PASSWORD CHANGE] Success for user: ${userId}`);

    sendSuccess(res, 200, undefined, 'Password changed successfully');
  } catch (error) {
    logger.error('[CHANGE PASSWORD] Error:', error);
    return sendError(res, 500, 'Password change failed');
  }
}

/**
 * Generate new token pair with optional custom expiry.
 * POST /user/generate-token
 *
 * Body (optional):
 *   - expiresIn: number — token lifetime in seconds (default: server config, max: 30 days)
 */
export async function generateToken(req: Request, res: Response): Promise<void> {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  try {
    const user = await User.findById(userId).select('+tokenVersion');
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    // Optional custom expiry (max 30 days = 2592000 seconds)
    const MAX_EXPIRES_IN = 30 * 24 * 60 * 60;
    let expiresIn: number | undefined;
    if (req.body?.expiresIn !== undefined) {
      expiresIn = parseInt(req.body.expiresIn, 10);
      if (isNaN(expiresIn) || expiresIn < 1) {
        return sendError(res, 400, 'expiresIn must be a positive integer (seconds)', 'INVALID_EXPIRES_IN');
      }
      if (expiresIn > MAX_EXPIRES_IN) {
        return sendError(res, 400, `expiresIn must not exceed ${MAX_EXPIRES_IN} seconds (30 days)`, 'EXPIRES_IN_TOO_LARGE');
      }
    }

    const { accessToken, refreshToken, expiresIn: actualExpiresIn } = await issueTokens(user, expiresIn);

    sendSuccess(res, 200, { accessToken, refreshToken, expiresIn: actualExpiresIn });
  } catch (error) {
    logger.error('[GET TOKEN] Error:', error);
    return sendError(res, 500, 'Generate token failed');
  }
}

// Admin User Management Endpoints

/**
 * List all users (System Admin) or organization users (Org Admin)
 * GET /users
 */
export async function listAllUsers(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  try {
    const { organizationId, role, search } = req.query;

    const filter: Record<string, unknown> = {};

    if (admin.isOrgAdmin) {
      filter.organizationId = req.user!.organizationId;
      if (organizationId && organizationId !== req.user!.organizationId) {
        return sendError(res, 403, 'Forbidden: Can only view users in your organization');
      }
    } else if (organizationId) {
      filter.organizationId = organizationId;
    }

    if (role && ['user', 'admin'].includes(role as string)) {
      filter.role = role;
    }
    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const { offset, limit: limitNum } = parsePagination(req.query.offset, req.query.limit);

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('_id username email role isEmailVerified organizationId createdAt updatedAt')
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limitNum)
        .lean(),
      User.countDocuments(filter),
    ]);

    const orgIds = users.map(u => u.organizationId).filter((id): id is NonNullable<typeof id> => id != null);
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name').lean()
      : [];
    const orgMap = new Map(orgs.map(o => [o._id.toString(), o.name]));

    const usersWithOrg = users.map(user => ({
      ...formatUserResponse(user, user.organizationId ? orgMap.get(user.organizationId.toString()) || null : null),
    }));

    sendSuccess(res, 200, {
      users: usersWithOrg,
      pagination: { total, offset, limit: limitNum, hasMore: offset + limitNum < total },
    });
  } catch (error) {
    logger.error('[LIST USERS] Error:', error);
    return sendError(res, 500, 'Failed to list users');
  }
}

/**
 * Get user by ID (System Admin or Org Admin for their org members)
 * GET /users/:id
 */
export async function getUserById(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  try {
    const { id } = req.params;

    const user = await User.findById(id)
      .select('_id username email role isEmailVerified organizationId featureOverrides createdAt updatedAt')
      .lean();

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (admin.isOrgAdmin && user.organizationId?.toString() !== req.user!.organizationId) {
      return sendError(res, 403, 'Forbidden: Can only view users in your organization');
    }

    let organizationName: string | null = null;
    let organization: OrgSummary | null = null;
    let tier: QuotaTier = 'developer';
    let isSystem = false;

    if (user.organizationId) {
      const org = await Organization.findById(user.organizationId).select('_id name slug tier').lean();
      if (org) {
        organizationName = org.name;
        organization = { id: org._id.toString(), name: org.name, slug: org.slug };
        tier = (org.tier as QuotaTier) || 'developer';
        isSystem = org._id.toString() === SYSTEM_ORG_ID;
      }
    }

    const overrides = toOverridesRecord(user.featureOverrides as Map<string, boolean> | undefined);
    const features = resolveUserFeatures(tier, overrides, isSystem);

    sendSuccess(res, 200, { user: formatUserResponse(user, organizationName, organization ?? undefined, { tier, features }) });
  } catch (error) {
    logger.error('[GET USER BY ID] Error:', error);
    return sendError(res, 500, 'Failed to fetch user');
  }
}

/**
 * Update user by ID (System Admin or Org Admin for their org members)
 * PUT /users/:id
 */
export async function updateUserById(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  try {
    const id = req.params.id as string;
    const { username, email, role, organizationId, password } = req.body;

    const user = await User.findById(id).select('+password +tokenVersion');
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (admin.isOrgAdmin && user.organizationId?.toString() !== req.user!.organizationId) {
      return sendError(res, 403, 'Forbidden: Can only update users in your organization');
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

    if (role !== undefined && ['user', 'admin'].includes(role)) {
      user.role = role;
      changes.push('role');
    }

    if (password !== undefined) {
      if (password.length < config.auth.passwordMinLength) {
        return sendError(res, 400, `Password must be at least ${config.auth.passwordMinLength} characters`, 'INVALID_PASSWORD');
      }
      user.password = password;
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      changes.push('password');
    }

    if (admin.isSysAdmin && organizationId !== undefined) {
      if (organizationId === null || organizationId === '') {
        if (user.organizationId) {
          await Organization.updateOne({ _id: user.organizationId }, { $pull: { members: user._id } });
        }
        user.organizationId = undefined;
        changes.push('organizationId (removed)');
      } else {
        const newOrg = await Organization.findById(organizationId);
        if (!newOrg) {
          return sendError(res, 404, 'Organization not found');
        }

        if (user.organizationId && user.organizationId.toString() !== organizationId) {
          await Organization.updateOne({ _id: user.organizationId }, { $pull: { members: user._id } });
        }

        if (!newOrg.members.some(m => m.toString() === user._id.toString())) {
          newOrg.members.push(user._id);
          await newOrg.save();
        }

        user.organizationId = organizationId;
        changes.push('organizationId');
      }
    }

    await user.save();

    logger.info(`[UPDATE USER BY ID] User ${id} updated by ${admin.adminType} ${req.user!.sub}. Changes: ${changes.join(', ')}`);

    const organizationName = await getOrgName(user.organizationId?.toString());

    sendSuccess(res, 200, { user: formatUserResponse(user, organizationName), changes }, 'User updated successfully');
  } catch (error) {
    logger.error('[UPDATE USER BY ID] Error:', error);
    return sendError(res, 500, 'Failed to update user');
  }
}

/**
 * Delete user by ID (System Admin or Org Admin for their org members)
 * DELETE /users/:id
 */
export async function deleteUserById(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  try {
    const { id } = req.params;

    if (id === req.user!.sub) {
      return sendError(res, 400, 'Cannot delete your own account through this endpoint');
    }

    const user = await User.findById(id);
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (admin.isOrgAdmin && user.organizationId?.toString() !== req.user!.organizationId) {
      return sendError(res, 403, 'Forbidden: Can only delete users in your organization');
    }

    const ownedOrg = await Organization.findOne({ owner: user._id });
    if (ownedOrg) {
      return sendError(res, 400, 'Cannot delete user who is an organization owner. Transfer ownership first.');
    }

    if (user.organizationId) {
      await Organization.updateOne({ _id: user.organizationId }, { $pull: { members: user._id } });
    }

    await User.findByIdAndDelete(id);

    logger.info(`[DELETE USER BY ID] User ${id} deleted by ${admin.adminType} ${req.user!.sub}`);
    audit(req, 'admin.user.delete', { targetType: 'user', targetId: String(id) });

    sendSuccess(res, 200, undefined, 'User deleted successfully');
  } catch (error) {
    logger.error('[DELETE USER BY ID] Error:', error);
    return sendError(res, 500, 'Failed to delete user');
  }
}

/**
 * Update feature overrides for a user (Admin only)
 * PUT /users/:id/features
 */
export async function updateUserFeatures(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  try {
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

    const user = await User.findById(id).select('_id username email role isEmailVerified organizationId featureOverrides');
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    // Org admin can only update users in their org
    if (admin.isOrgAdmin && user.organizationId?.toString() !== req.user!.organizationId) {
      return sendError(res, 403, 'Forbidden: Can only update users in your organization');
    }

    // Apply overrides
    user.featureOverrides = new Map(Object.entries(overrides as Record<string, boolean>));
    await user.save();

    // Resolve features for response
    let tier: QuotaTier = 'developer';
    let isSystem = false;
    let organizationName: string | null = null;

    if (user.organizationId) {
      const org = await Organization.findById(user.organizationId).select('name tier').lean();
      organizationName = org?.name || null;
      tier = (org?.tier as QuotaTier) || 'developer';
      isSystem = user.organizationId.toString() === SYSTEM_ORG_ID;
    }

    const features = resolveUserFeatures(tier, overrides as Record<string, boolean>, isSystem);

    logger.info(`[UPDATE USER FEATURES] User ${id} features updated by ${admin.adminType} ${req.user!.sub}`);

    sendSuccess(res, 200, {
      user: formatUserResponse(user, organizationName, undefined, { tier, features }),
    }, 'Feature overrides updated successfully');
  } catch (error) {
    logger.error('[UPDATE USER FEATURES] Error:', error);
    return sendError(res, 500, 'Failed to update user features');
  }
}
