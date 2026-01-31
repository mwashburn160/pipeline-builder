import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { User, Organization } from '../models';
import { UserFilter, LeanUser } from '../types';
import {
  logger,
  sendError,
  sendOk,
  sendMessage,
  sendPaginated,
  ErrorCode,
  HttpStatus,
  generateTokenPair,
} from '../utils';

/**
 * Check if user is system admin
 */
function isSystemAdmin(req: Request): boolean {
  if (req.user?.role !== 'admin') return false;
  const orgId = req.user?.organizationId?.toLowerCase();
  const orgName = req.user?.organizationName?.toLowerCase();
  return orgId === 'system' || orgName === 'system';
}

/**
 * Get current user profile
 * GET /user/profile
 */
export async function getUser(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const user = await User.findById(userId)
      .select('_id username email role isEmailVerified organizationId tokenVersion')
      .lean();

    if (!user) {
      return sendError(res, HttpStatus.NOT_FOUND, 'User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Look up organization name if user has an organizationId
    let organizationName: string | null = null;
    if (user.organizationId) {
      const org = await Organization.findById(user.organizationId).select('name').lean();
      organizationName = org?.name || null;
    }

    sendOk(res, {
      user: {
        ...user,
        sub: user._id.toString(),
        organizationId: user.organizationId?.toString() || null,
        organizationName,
      },
    });
  } catch (err) {
    logger.error('[GET USER] Error:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to fetch user', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Check if user is organization admin (admin role in any non-system org)
 */
function isOrgAdmin(req: Request): boolean {
  return req.user?.role === 'admin' && !isSystemAdmin(req);
}

/**
 * List all users (System Admin) or organization users (Org Admin)
 * GET /users
 * Query params: organizationId, role, page, limit, search
 */
export async function listAllUsers(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const isSysAdmin = isSystemAdmin(req);
    const isOrgAdminUser = isOrgAdmin(req);

    // Must be either system admin or org admin
    if (!isSysAdmin && !isOrgAdminUser) {
      return sendError(res, HttpStatus.FORBIDDEN, 'Admin access required', ErrorCode.ADMIN_REQUIRED);
    }

    const { organizationId, role, search, page = '1', limit = '20' } = req.query;

    // Build filter
    const filter: UserFilter = {};

    // Org admins can only view users in their organization
    if (isOrgAdminUser) {
      filter.organizationId = req.user.organizationId;
      // If they specify a different org, deny
      if (organizationId && organizationId !== req.user.organizationId) {
        return sendError(res, HttpStatus.FORBIDDEN, 'Can only view users in your organization', ErrorCode.FORBIDDEN);
      }
    } else if (organizationId) {
      // System admin can filter by any org
      filter.organizationId = organizationId as string;
    }

    if (role && ['user', 'admin'].includes(role as string)) {
      filter.role = role as 'user' | 'admin';
    }
    if (search) {
      filter.$or = [
        { username: { $regex: search as string, $options: 'i' } },
        { email: { $regex: search as string, $options: 'i' } },
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

    // Get organization names for all users
    const orgIds = users.map(u => u.organizationId).filter((id): id is NonNullable<typeof id> => id != null);
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name').lean()
      : [];
    const orgMap = new Map(orgs.map(o => [o._id.toString(), o.name]));

    const usersWithOrg = users.map(user => {
      const typedUser = user as LeanUser;
      return {
        id: typedUser._id.toString(),
        username: typedUser.username,
        email: typedUser.email,
        role: typedUser.role,
        isEmailVerified: typedUser.isEmailVerified,
        organizationId: typedUser.organizationId?.toString() || null,
        organizationName: typedUser.organizationId ? orgMap.get(typedUser.organizationId.toString()) || null : null,
        createdAt: typedUser.createdAt,
        updatedAt: typedUser.updatedAt,
      };
    });

    sendPaginated(res, usersWithOrg, total, pageNum, limitNum);
  } catch (err) {
    logger.error('[LIST USERS] Error:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to list users', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Get user by ID (System Admin or Org Admin for their org members)
 * GET /users/:id
 */
export async function getUserById(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const isSysAdmin = isSystemAdmin(req);
    const isOrgAdminUser = isOrgAdmin(req);

    if (!isSysAdmin && !isOrgAdminUser) {
      return sendError(res, HttpStatus.FORBIDDEN, 'Admin access required', ErrorCode.ADMIN_REQUIRED);
    }

    const { id } = req.params;

    const user = await User.findById(id)
      .select('_id username email role isEmailVerified organizationId createdAt updatedAt')
      .lean();

    if (!user) {
      return sendError(res, HttpStatus.NOT_FOUND, 'User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Org admins can only view users in their organization
    if (isOrgAdminUser && user.organizationId?.toString() !== req.user.organizationId) {
      return sendError(res, HttpStatus.FORBIDDEN, 'Can only view users in your organization', ErrorCode.FORBIDDEN);
    }

    // Get organization info
    let organizationName: string | null = null;
    let organization: { id: string; name: string; slug: string } | null = null;
    if (user.organizationId) {
      const org = await Organization.findById(user.organizationId).select('_id name slug').lean();
      if (org) {
        organizationName = org.name;
        organization = {
          id: org._id.toString(),
          name: org.name,
          slug: org.slug,
        };
      }
    }

    const typedUser = user as LeanUser;
    res.json({
      success: true,
      statusCode: 200,
      user: {
        id: typedUser._id.toString(),
        username: typedUser.username,
        email: typedUser.email,
        role: typedUser.role,
        isEmailVerified: typedUser.isEmailVerified,
        organizationId: typedUser.organizationId?.toString() || null,
        organizationName,
        organization,
        createdAt: typedUser.createdAt,
        updatedAt: typedUser.updatedAt,
      },
    });
  } catch (err) {
    logger.error('[GET USER BY ID] Error:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to fetch user', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Update user by ID (System Admin or Org Admin for their org members)
 * PUT /users/:id
 * Body: { username?, email?, role?, organizationId? }
 * Note: Org admins cannot change organizationId - only system admins can
 */
export async function updateUserById(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const isSysAdmin = isSystemAdmin(req);
    const isOrgAdminUser = isOrgAdmin(req);

    if (!isSysAdmin && !isOrgAdminUser) {
      return sendError(res, HttpStatus.FORBIDDEN, 'Admin access required', ErrorCode.ADMIN_REQUIRED);
    }

    const id = req.params.id as string;
    const { username, email, role, organizationId } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return sendError(res, HttpStatus.NOT_FOUND, 'User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Org admins can only update users in their organization
    if (isOrgAdminUser && user.organizationId?.toString() !== req.user.organizationId) {
      return sendError(res, HttpStatus.FORBIDDEN, 'Can only update users in your organization', ErrorCode.FORBIDDEN);
    }

    // Org admins cannot change organizationId
    if (isOrgAdminUser && organizationId !== undefined) {
      return sendError(res, HttpStatus.FORBIDDEN, 'Only system admins can change user organization', ErrorCode.SYSTEM_ADMIN_REQUIRED);
    }

    // Track changes for logging
    const changes: string[] = [];

    // Update username
    if (username !== undefined) {
      const existing = await User.findOne({
        username: username.trim().toLowerCase(),
        _id: { $ne: new Types.ObjectId(id) },
      });
      if (existing) {
        return sendError(res, HttpStatus.CONFLICT, 'Username already in use', ErrorCode.USERNAME_TAKEN);
      }
      user.username = username.trim().toLowerCase();
      changes.push('username');
    }

    // Update email
    if (email !== undefined) {
      const existing = await User.findOne({
        email: email.trim().toLowerCase(),
        _id: { $ne: new Types.ObjectId(id) },
      });
      if (existing) {
        return sendError(res, HttpStatus.CONFLICT, 'Email already in use', ErrorCode.EMAIL_TAKEN);
      }
      user.email = email.trim().toLowerCase();
      user.isEmailVerified = false;
      changes.push('email');
    }

    // Update role
    if (role !== undefined && ['user', 'admin'].includes(role)) {
      user.role = role;
      changes.push('role');
    }

    // Update organization (system admin only)
    if (isSysAdmin && organizationId !== undefined) {
      if (organizationId === null || organizationId === '') {
        // Remove from organization
        if (user.organizationId) {
          await Organization.updateOne(
            { _id: user.organizationId },
            { $pull: { members: user._id } },
          );
        }
        user.organizationId = undefined;
        changes.push('organizationId (removed)');
      } else {
        // Add to new organization
        const newOrg = await Organization.findById(organizationId);
        if (!newOrg) {
          return sendError(res, HttpStatus.NOT_FOUND, 'Organization not found', ErrorCode.ORG_NOT_FOUND);
        }

        // Remove from old organization if different
        if (user.organizationId && user.organizationId.toString() !== organizationId) {
          await Organization.updateOne(
            { _id: user.organizationId },
            { $pull: { members: user._id } },
          );
        }

        // Add to new organization
        if (!newOrg.members.some(m => m.toString() === user._id.toString())) {
          newOrg.members.push(user._id);
          await newOrg.save();
        }

        user.organizationId = organizationId as any;
        changes.push('organizationId');
      }
    }

    await user.save();

    const adminType = isSysAdmin ? 'system admin' : 'org admin';
    logger.info(`[UPDATE USER BY ID] User ${id} updated by ${adminType} ${req.user.sub}. Changes: ${changes.join(', ')}`);

    // Get organization name
    let organizationName: string | null = null;
    if (user.organizationId) {
      const org = await Organization.findById(user.organizationId).select('name').lean();
      organizationName = org?.name || null;
    }

    res.json({
      success: true,
      statusCode: 200,
      message: 'User updated successfully',
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        organizationId: user.organizationId?.toString() || null,
        organizationName,
      },
      changes,
    });
  } catch (err) {
    logger.error('[UPDATE USER BY ID] Error:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to update user', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Delete user by ID (System Admin only)
 * DELETE /users/:id
 */
export async function deleteUserById(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    if (!isSystemAdmin(req)) {
      return sendError(res, HttpStatus.FORBIDDEN, 'System admin access required', ErrorCode.SYSTEM_ADMIN_REQUIRED);
    }

    const { id } = req.params;

    // Prevent deleting yourself
    if (id === req.user.sub) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Cannot delete your own account through this endpoint', ErrorCode.CANNOT_DELETE_SELF);
    }

    const user = await User.findById(id);
    if (!user) {
      return sendError(res, HttpStatus.NOT_FOUND, 'User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Remove user from organization if member
    if (user.organizationId) {
      await Organization.updateOne(
        { _id: user.organizationId },
        { $pull: { members: user._id } },
      );

      // If user is owner of org, need to handle that
      const org = await Organization.findOne({ owner: user._id });
      if (org) {
        return sendError(res, HttpStatus.BAD_REQUEST, 'Cannot delete user who is an organization owner. Transfer ownership first.', ErrorCode.TRANSFER_REQUIRED);
      }
    }

    await User.findByIdAndDelete(id);

    logger.info(`[DELETE USER BY ID] User ${id} deleted by system admin ${req.user.sub}`);

    res.json({
      success: true,
      statusCode: 200,
      message: 'User deleted successfully',
    });
  } catch (err) {
    logger.error('[DELETE USER BY ID] Error:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to delete user', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Update user profile
 * PATCH /user/profile
 */
export async function updateUser(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const { username, email } = req.body;
    const updates: Record<string, any> = {};

    if (username) updates.username = username.trim().toLowerCase();
    if (email) updates.email = email.trim().toLowerCase();

    if (Object.keys(updates).length === 0) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'No valid fields to update', ErrorCode.INVALID_INPUT);
    }

    // Check email uniqueness
    if (updates.email) {
      const existing = await User.findOne({
        email: updates.email,
        _id: { $ne: new Types.ObjectId(userId) },
      });
      if (existing) {
        return sendError(res, HttpStatus.CONFLICT, 'Email already in use', ErrorCode.EMAIL_TAKEN);
      }
      updates.isEmailVerified = false;
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { new: true, runValidators: true },
    ).lean();

    if (!updatedUser) {
      return sendError(res, HttpStatus.NOT_FOUND, 'User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Look up organization name if user has an organizationId
    let organizationName: string | null = null;
    if (updatedUser.organizationId) {
      const org = await Organization.findById(updatedUser.organizationId).select('name').lean();
      organizationName = org?.name || null;
    }

    logger.info(`[UPDATE USER] Success for user: ${userId}`);

    res.json({
      success: true,
      statusCode: 200,
      user: {
        ...updatedUser,
        sub: updatedUser._id.toString(),
        organizationId: updatedUser.organizationId?.toString() || null,
        organizationName,
      },
    });
  } catch (err) {
    logger.error('[UPDATE USER] Error:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Update failed', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Delete user account
 * DELETE /user/account
 */
export async function deleteUser(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const result = await User.findByIdAndDelete(userId);

    if (!result) {
      return sendError(res, HttpStatus.NOT_FOUND, 'User not found', ErrorCode.USER_NOT_FOUND);
    }

    logger.info(`[DELETE USER] Account deleted: ${userId}`);

    sendMessage(res, 'Account deleted successfully');
  } catch (err) {
    logger.error('[DELETE USER] Error:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to delete account', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Change user password
 * POST /user/change-password
 */
export async function changePassword(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Current password and new password are required', ErrorCode.MISSING_FIELDS);
    }

    const user = await User.findById(userId).select('+password +tokenVersion');
    if (!user || !user.password) {
      return sendError(res, HttpStatus.NOT_FOUND, 'User not found', ErrorCode.USER_NOT_FOUND);
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Current password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    }

    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();

    logger.info(`[PASSWORD CHANGE] Success for user: ${userId}`);

    sendMessage(res, 'Password changed successfully');
  } catch (err) {
    logger.error('[CHANGE PASSWORD] Error:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Password change failed', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Generate new token pair
 * POST /user/generate-token
 */
export async function generateToken(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const user = await User.findById(userId).select('+tokenVersion');
    if (!user) {
      return sendError(res, HttpStatus.NOT_FOUND, 'User not found', ErrorCode.USER_NOT_FOUND);
    }

    const { accessToken, refreshToken } = generateTokenPair(user);

    sendOk(res, { accessToken, refreshToken }, 'Tokens generated successfully');
  } catch (err) {
    logger.error('[GET TOKEN] Error:', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to generate tokens', ErrorCode.INTERNAL_ERROR);
  }
}
