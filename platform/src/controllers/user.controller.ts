import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { User, Organization } from '../models';
import { logger, sendError, generateTokenPair } from '../utils';

// ============================================================================
// Auth Helpers
// ============================================================================

function isSystemAdmin(req: Request): boolean {
  if (req.user?.role !== 'admin') return false;
  const orgId = req.user?.organizationId?.toLowerCase();
  const orgName = req.user?.organizationName?.toLowerCase();
  return orgId === 'system' || orgName === 'system';
}

function isOrgAdmin(req: Request): boolean {
  return req.user?.role === 'admin' && !isSystemAdmin(req);
}

interface AdminContext {
  isSysAdmin: boolean;
  isOrgAdmin: boolean;
  adminType: string;
}

function getAdminContext(req: Request, res: Response): AdminContext | null {
  if (!req.user) {
    sendError(res, 401, 'Unauthorized');
    return null;
  }

  const isSysAdmin = isSystemAdmin(req);
  const isOrgAdminUser = isOrgAdmin(req);

  if (!isSysAdmin && !isOrgAdminUser) {
    sendError(res, 403, 'Forbidden: Admin access required');
    return null;
  }

  return {
    isSysAdmin,
    isOrgAdmin: isOrgAdminUser,
    adminType: isSysAdmin ? 'system admin' : 'org admin',
  };
}

function requireAuth(req: Request, res: Response): string | null {
  const userId = req.user?.sub;
  if (!userId) {
    sendError(res, 401, 'Unauthorized');
    return null;
  }
  return userId;
}

// ============================================================================
// Org Lookup Helper
// ============================================================================

async function getOrgName(orgId: string | undefined): Promise<string | null> {
  if (!orgId) return null;
  const org = await Organization.findById(orgId).select('name').lean();
  return org?.name || null;
}

function formatUserResponse(user: any, organizationName: string | null, organization?: any) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    isEmailVerified: user.isEmailVerified,
    organizationId: user.organizationId?.toString() || null,
    organizationName,
    ...(organization && { organization }),
    ...(user.createdAt && { createdAt: user.createdAt }),
    ...(user.updatedAt && { updatedAt: user.updatedAt }),
    ...(user.tokenVersion !== undefined && { tokenVersion: user.tokenVersion }),
  };
}

// ============================================================================
// User Profile Endpoints
// ============================================================================

/**
 * Get current user profile
 * GET /user/profile
 */
export async function getUser(req: Request, res: Response): Promise<void> {
  const userId = requireAuth(req, res);
  if (!userId) return;

  try {
    const user = await User.findById(userId)
      .select('_id username email role isEmailVerified organizationId tokenVersion')
      .lean();

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const organizationName = await getOrgName(user.organizationId?.toString());

    res.json({
      success: true,
      statusCode: 200,
      data: { user: formatUserResponse(user, organizationName) },
    });
  } catch (err) {
    logger.error('[GET USER] Error:', err);
    return sendError(res, 500, 'Failed to fetch user');
  }
}

/**
 * Update user profile
 * PATCH /user/profile
 */
export async function updateUser(req: Request, res: Response): Promise<void> {
  const userId = requireAuth(req, res);
  if (!userId) return;

  try {
    const { username, email } = req.body;
    const updates: Record<string, any> = {};

    if (username) updates.username = username.trim().toLowerCase();
    if (email) updates.email = email.trim().toLowerCase();

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, 'No valid fields to update', 'INVALID_FIELDS');
    }

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
      { new: true, runValidators: true },
    ).lean();

    if (!updatedUser) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const organizationName = await getOrgName(updatedUser.organizationId?.toString());

    logger.info(`[UPDATE USER] Success for user: ${userId}`);

    res.json({
      success: true,
      statusCode: 200,
      data: { user: formatUserResponse(updatedUser, organizationName) },
    });
  } catch (err) {
    logger.error('[UPDATE USER] Error:', err);
    return sendError(res, 500, 'Update failed');
  }
}

/**
 * Delete user account
 * DELETE /user/account
 */
export async function deleteUser(req: Request, res: Response): Promise<void> {
  const userId = requireAuth(req, res);
  if (!userId) return;

  try {
    const result = await User.findByIdAndDelete(userId);

    if (!result) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    logger.info(`[DELETE USER] Account deleted: ${userId}`);

    res.json({ success: true, statusCode: 200, message: 'Account successfully deleted' });
  } catch (err) {
    logger.error('[DELETE USER] Error:', err);
    return sendError(res, 500, 'Delete failed');
  }
}

/**
 * Change user password
 * POST /user/change-password
 */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const userId = requireAuth(req, res);
  if (!userId) return;

  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return sendError(res, 400, 'Missing password fields', 'MISSING_FIELDS');
    }

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

    res.json({ success: true, statusCode: 200, message: 'Password changed successfully' });
  } catch (err) {
    logger.error('[CHANGE PASSWORD] Error:', err);
    return sendError(res, 500, 'Password change failed');
  }
}

/**
 * Generate new token pair
 * POST /user/generate-token
 */
export async function generateToken(req: Request, res: Response): Promise<void> {
  const userId = requireAuth(req, res);
  if (!userId) return;

  try {
    const user = await User.findById(userId).select('+tokenVersion');
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const { accessToken, refreshToken } = generateTokenPair(user);

    res.json({ success: true, statusCode: 200, accessToken, refreshToken });
  } catch (err) {
    logger.error('[GET TOKEN] Error:', err);
    return sendError(res, 500, 'Generate token failed');
  }
}

// ============================================================================
// Admin User Management Endpoints
// ============================================================================

/**
 * List all users (System Admin) or organization users (Org Admin)
 * GET /users
 */
export async function listAllUsers(req: Request, res: Response): Promise<void> {
  const admin = getAdminContext(req, res);
  if (!admin) return;

  try {
    const { organizationId, role, search, page = '1', limit = '20' } = req.query;

    const filter: any = {};

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

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('_id username email role isEmailVerified organizationId createdAt updatedAt')
        .sort({ createdAt: -1 })
        .skip(skip)
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

    res.json({
      success: true,
      statusCode: 200,
      users: usersWithOrg,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    logger.error('[LIST USERS] Error:', err);
    return sendError(res, 500, 'Failed to list users');
  }
}

/**
 * Get user by ID (System Admin or Org Admin for their org members)
 * GET /users/:id
 */
export async function getUserById(req: Request, res: Response): Promise<void> {
  const admin = getAdminContext(req, res);
  if (!admin) return;

  try {
    const { id } = req.params;

    const user = await User.findById(id)
      .select('_id username email role isEmailVerified organizationId createdAt updatedAt')
      .lean();

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (admin.isOrgAdmin && user.organizationId?.toString() !== req.user!.organizationId) {
      return sendError(res, 403, 'Forbidden: Can only view users in your organization');
    }

    let organizationName: string | null = null;
    let organization: any = null;

    if (user.organizationId) {
      const org = await Organization.findById(user.organizationId).select('_id name slug').lean();
      if (org) {
        organizationName = org.name;
        organization = { id: org._id.toString(), name: org.name, slug: org.slug };
      }
    }

    res.json({
      success: true,
      statusCode: 200,
      user: formatUserResponse(user, organizationName, organization),
    });
  } catch (err) {
    logger.error('[GET USER BY ID] Error:', err);
    return sendError(res, 500, 'Failed to fetch user');
  }
}

/**
 * Update user by ID (System Admin or Org Admin for their org members)
 * PUT /users/:id
 */
export async function updateUserById(req: Request, res: Response): Promise<void> {
  const admin = getAdminContext(req, res);
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
      if (password.length < 8) {
        return sendError(res, 400, 'Password must be at least 8 characters', 'INVALID_PASSWORD');
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

        user.organizationId = organizationId as any;
        changes.push('organizationId');
      }
    }

    await user.save();

    logger.info(`[UPDATE USER BY ID] User ${id} updated by ${admin.adminType} ${req.user!.sub}. Changes: ${changes.join(', ')}`);

    const organizationName = await getOrgName(user.organizationId?.toString());

    res.json({
      success: true,
      statusCode: 200,
      message: 'User updated successfully',
      user: formatUserResponse(user, organizationName),
      changes,
    });
  } catch (err) {
    logger.error('[UPDATE USER BY ID] Error:', err);
    return sendError(res, 500, 'Failed to update user');
  }
}

/**
 * Delete user by ID (System Admin or Org Admin for their org members)
 * DELETE /users/:id
 */
export async function deleteUserById(req: Request, res: Response): Promise<void> {
  const admin = getAdminContext(req, res);
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

    res.json({ success: true, statusCode: 200, message: 'User deleted successfully' });
  } catch (err) {
    logger.error('[DELETE USER BY ID] Error:', err);
    return sendError(res, 500, 'Failed to delete user');
  }
}