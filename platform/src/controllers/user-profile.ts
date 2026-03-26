import { createLogger, sendError, sendSuccess, resolveUserFeatures, SYSTEM_ORG_ID } from '@mwashburn160/api-core';
import type { FeatureFlag, QuotaTier } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { audit } from '../helpers/audit';
import { requireAuthUserId } from '../helpers/controller-helper';
import { User, Organization, UserOrganization } from '../models';
import { issueTokens } from '../utils/token';
import { validateBody, updateProfileSchema, changePasswordSchema } from '../utils/validation';

const logger = createLogger('UserProfileController');

/** Compact organization summary included in user responses. */
export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
}

/** Membership info returned alongside user responses. */
export interface OrgMembership {
  id: string;
  name: string;
  role: string;
}

/** Fields required to build a user API response. */
export interface UserResponseInput {
  _id: Types.ObjectId;
  username: string;
  email: string;
  isEmailVerified: boolean;
  lastActiveOrgId?: Types.ObjectId | string;
  featureOverrides?: Map<string, boolean> | Record<string, boolean>;
  createdAt?: Date;
  updatedAt?: Date;
  tokenVersion?: number;
}

/** Convert Mongoose Map or plain object to Record<string, boolean>. */
export function toOverridesRecord(overrides?: Map<string, boolean> | Record<string, boolean>): Record<string, boolean> | undefined {
  if (!overrides) return undefined;
  if (overrides instanceof Map) return Object.fromEntries(overrides);
  return overrides;
}

/**
 * Build a standardized user response object for API output.
 * @param user - User fields from DB
 * @param opts - Optional response enrichment fields
 */
export function formatUserResponse(
  user: UserResponseInput,
  opts?: {
    activeOrgRole?: string;
    activeOrgName?: string | null;
    organization?: OrgSummary;
    organizations?: OrgMembership[];
    tier?: QuotaTier;
    features?: FeatureFlag[];
  },
) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: opts?.activeOrgRole || null,
    isEmailVerified: user.isEmailVerified,
    organizationId: user.lastActiveOrgId?.toString() || null,
    organizationName: opts?.activeOrgName || null,
    ...(opts?.organization && { organization: opts.organization }),
    ...(opts?.organizations && { organizations: opts.organizations }),
    ...(opts?.tier && { tier: opts.tier }),
    ...(opts?.features && { features: opts.features }),
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
      .select('_id username email isEmailVerified lastActiveOrgId featureOverrides tokenVersion')
      .lean();

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    // Get all org memberships for this user
    const memberships = await UserOrganization.find({ userId: user._id }).lean();
    const orgIds = memberships.map(m => m.organizationId);

    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name tier').lean()
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

    // Resolve active org tier and features
    const activeOrgId = req.user!.organizationId || user.lastActiveOrgId?.toString();
    let activeOrgName: string | null = null;
    let activeOrgRole: string | null = null;
    let tier: QuotaTier = 'developer';
    let isSystem = false;

    if (activeOrgId) {
      const activeOrg = orgMap.get(activeOrgId.toString());
      if (activeOrg) {
        activeOrgName = activeOrg.name;
        tier = (activeOrg.tier as QuotaTier) || 'developer';
        isSystem = activeOrgId.toString() === SYSTEM_ORG_ID;
      }
      const activeMembership = memberships.find(m => m.organizationId.toString() === activeOrgId.toString());
      activeOrgRole = activeMembership?.role || null;
    }

    const overrides = toOverridesRecord(user.featureOverrides as Map<string, boolean> | undefined);
    const features = resolveUserFeatures(tier, overrides, isSystem);

    sendSuccess(res, 200, {
      user: formatUserResponse(user, {
        activeOrgRole: activeOrgRole || undefined,
        activeOrgName,
        organizations,
        tier,
        features,
      }),
    });
  } catch (error) {
    logger.error('[GET USER] Error:', error);
    return sendError(res, 500, 'Failed to fetch user');
  }
}

/**
 * List all organizations the current user belongs to.
 * GET /user/organizations
 *
 * Returns all {@link UserOrganization} records for the authenticated user,
 * including org name, slug, role, isActive status, and joinedAt.
 */
export async function listUserOrganizations(req: Request, res: Response): Promise<void> {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;

  try {
    const memberships = await UserOrganization.find({ userId }).sort({ joinedAt: 1 }).lean();
    const orgIds = memberships.map(m => m.organizationId);

    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name slug').lean()
      : [];
    const orgMap = new Map(orgs.map(o => [o._id.toString(), o]));

    const organizations = memberships.map(m => {
      const org = orgMap.get(m.organizationId.toString());
      return {
        organizationId: m.organizationId.toString(),
        organizationName: org?.name || 'Unknown',
        slug: org?.slug,
        role: m.role,
        isActive: m.isActive,
        joinedAt: m.joinedAt?.toISOString(),
      };
    });

    sendSuccess(res, 200, { organizations });
  } catch (error) {
    logger.error('[LIST USER ORGS] Error:', error);
    return sendError(res, 500, 'Failed to list organizations');
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

    // Get active org role from membership
    const activeOrgId = updatedUser.lastActiveOrgId?.toString();
    let organizationName: string | null = null;
    let activeOrgRole: string | undefined;

    if (activeOrgId) {
      const [org, membership] = await Promise.all([
        Organization.findById(activeOrgId).select('name').lean(),
        UserOrganization.findOne({ userId: updatedUser._id, organizationId: activeOrgId, isActive: true }).lean(),
      ]);
      organizationName = org?.name || null;
      activeOrgRole = membership?.role;
    }

    logger.info(`[UPDATE USER] Success for user: ${userId}`);

    sendSuccess(res, 200, { user: formatUserResponse(updatedUser, { activeOrgRole, activeOrgName: organizationName }) });
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

    // Clean up all org memberships
    await UserOrganization.deleteMany({ userId: new Types.ObjectId(userId) });

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
 *   - expiresIn: number - token lifetime in seconds (default: server config, max: 30 days)
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

    const { accessToken, refreshToken, expiresIn: actualExpiresIn } = await issueTokens(user, user.lastActiveOrgId?.toString(), expiresIn);

    sendSuccess(res, 200, { accessToken, refreshToken, expiresIn: actualExpiresIn });
  } catch (error) {
    logger.error('[GET TOKEN] Error:', error);
    return sendError(res, 500, 'Generate token failed');
  }
}
