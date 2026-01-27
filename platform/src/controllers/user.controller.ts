import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../index';
import User from '../models/user.model';
import {
  createAccessTokenPayload,
  createRefreshTokenPayload,
  sendError,
} from '../utils/auth.utils';
import logger from '../utils/logger.utils';

export async function getUser(req: Request, res: Response) {
  try {
    const userId = req.user?.sub;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    const user = await User.findById(userId)
      .select('_id username email role isEmailVerified organizationId tokenVersion')
      .lean();

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    return res.json({
      success: true,
      user: {
        ...user,
        sub: user._id.toString(),
        organizationId: user.organizationId?.toString() || null,
      },
    });
  } catch (err) {
    logger.error('[GET USER] Error:', err);
    return sendError(res, 500, 'Failed to fetch user');
  }
}

export async function deleteUser(req: Request, res: Response) {
  try {
    const userId = req.user?.sub;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    const result = await User.findByIdAndDelete(userId);

    if (!result) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    logger.info(`[DELETE USER] Account deleted: ${userId}`);
    return res.json({
      success: true,
      message: 'Account successfully deleted',
    });
  } catch (err) {
    logger.error('[DELETE USER] Error:', err);
    return sendError(res, 500, 'Delete failed');
  }
}

export async function generateToken(req: Request, res: Response) {
  try {
    const userId = req.user?.sub;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    const user = await User.findById(userId).select('+tokenVersion');
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const accessToken = jwt.sign(
      createAccessTokenPayload(user as any),
      config.auth.jwt.secret,
      { algorithm: config.auth.jwt.algorithm, expiresIn: config.auth.refreshToken.expiresIn },
    );

    const refreshToken = jwt.sign(
      createRefreshTokenPayload(user as any),
      config.auth.refreshToken.secret,
      { algorithm: config.auth.jwt.algorithm, expiresIn: config.auth.refreshToken.expiresIn },
    );

    return res.json({
      success: true,
      accessToken,
      refreshToken,
    });
  } catch (err) {
    logger.error('[GET TOKEN] Error:', err);
    return sendError(res, 500, 'Generate token failed');
  }
}

export async function updateUser(req: Request, res: Response) {
  try {
    const userId = req.user?.sub;
    if (!userId) return sendError(res, 401, 'Unauthorized');

    const { username, email } = req.body;

    const updates: any = {};
    if (username) updates.username = username.trim().toLowerCase();
    if (email) updates.email = email.trim().toLowerCase();

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, 'No valid fields to update', 'INVALID_FIELDS');
    }

    if (updates.email) {
      const existing = await User.findOne({ email: updates.email, _id: { $ne: userId } });
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

    logger.info(`[UPDATE USER] Success for user: ${userId}`);

    return res.json({
      success: true,
      user: {
        ...updatedUser,
        sub: updatedUser._id.toString(),
        organizationId: updatedUser.organizationId?.toString() || null,
      },
    });
  } catch (err) {
    logger.error('[UPDATE USER] Error:', err);
    return sendError(res, 500, 'Update failed');
  }
}

export async function changePassword(req: Request, res: Response) {
  try {
    const userId = req.user?.sub;
    if (!userId) return sendError(res, 401, 'Unauthorized');

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

    logger.info(`[PASSWORD CHANGE] Success for user: ${userId}. Session version incremented.`);

    return res.json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (err) {
    logger.error('[CHANGE PASSWORD] Error:', err);
    return sendError(res, 500, 'Password change failed');
  }
}