import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User, Organization } from '../models';
import { RegistrationResult, OrganizationCreateData } from '../types';
import {
  logger,
  sendError,
  sendCreated,
  sendOk,
  sendMessage,
  ErrorCode,
  HttpStatus,
  generateTokenPair,
  hashRefreshToken,
} from '../utils';

/**
 * Register a new user
 * POST /auth/register
 */
export async function register(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();
  let result: RegistrationResult | undefined;

  try {
    await session.withTransaction(async () => {
      const { username, email, password, organizationName } = req.body;

      if (!username || !email || !password) {
        throw new Error('MISSING_FIELDS');
      }

      const existing = await User.exists({
        $or: [
          { email: email.toLowerCase() },
          { username: username.toLowerCase() },
        ],
      }).session(session);

      if (existing) {
        throw new Error('DUPLICATE_CREDENTIALS');
      }

      // If creating an organization, user becomes admin
      const isCreatingOrg = organizationName?.trim().length >= 2;

      const user = new User({
        username,
        email,
        password,
        role: isCreatingOrg ? 'admin' : 'user',
      });

      let orgName: string | null = null;
      let orgId: string | null = null;

      // Create organization if name provided
      if (isCreatingOrg) {
        const trimmedOrgName = organizationName.trim();
        const isSystemOrg = trimmedOrgName.toLowerCase() === 'system';

        // If organization name is 'system', use 'system' as both ID and name
        const orgData: OrganizationCreateData = {
          name: isSystemOrg ? 'system' : trimmedOrgName,
          owner: user._id,
          members: [user._id],
        };

        // Set custom _id and unlimited quotas for system organization
        if (isSystemOrg) {
          orgData._id = 'system';
          // Set all quotas to -1 (unlimited)
          orgData.quotas = {
            plugins: -1,
            pipelines: -1,
            apiCalls: -1,
          };
        }

        const [org] = await Organization.create([orgData], { session });

        user.organizationId = org._id as mongoose.Types.ObjectId;
        orgName = org.name;
        orgId = String(org._id);
      }

      await user.save({ session });

      result = {
        sub: user._id.toString(),
        email: user.email,
        role: user.role,
        organizationId: orgId,
        organizationName: orgName,
      };
    });

    sendCreated(res, { user: result }, 'Registration successful');
  } catch (err: unknown) {
    const error = err as Error;
    if (error.message === 'MISSING_FIELDS') {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Missing required fields: username, email, and password are required', ErrorCode.MISSING_FIELDS);
    }
    if (error.message === 'DUPLICATE_CREDENTIALS') {
      return sendError(res, HttpStatus.CONFLICT, 'Email or username already in use', ErrorCode.DUPLICATE);
    }

    logger.error('Registration Failed', error);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Registration failed', ErrorCode.INTERNAL_ERROR);
  } finally {
    await session.endSession();
  }
}

/**
 * Login user
 * POST /auth/login
 */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return sendError(res, HttpStatus.BAD_REQUEST, 'Missing required fields: identifier and password are required', ErrorCode.MISSING_FIELDS);
    }

    const user = await User.findOne({
      $or: [
        { email: identifier.toLowerCase() },
        { username: identifier.toLowerCase() },
      ],
    }).select('+password +tokenVersion');

    if (!user || !(await user.comparePassword(password))) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Invalid credentials', ErrorCode.INVALID_CREDENTIALS);
    }

    const { accessToken, refreshToken } = generateTokenPair(user);
    const hashedRefresh = hashRefreshToken(refreshToken);

    await User.updateOne(
      { _id: user._id },
      { $set: { refreshToken: hashedRefresh } },
    );

    sendOk(res, { accessToken, refreshToken }, 'Login successful');
  } catch (err) {
    logger.error('Login Error', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Login failed', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Refresh tokens
 * POST /auth/refresh
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    const user = await User.findById(req.user.sub);
    if (!user) {
      return sendError(res, HttpStatus.NOT_FOUND, 'User not found', ErrorCode.USER_NOT_FOUND);
    }

    const { accessToken, refreshToken } = generateTokenPair(user);
    const hashedRefresh = hashRefreshToken(refreshToken);

    await User.updateOne(
      { _id: user._id },
      { $set: { refreshToken: hashedRefresh } },
    );

    sendOk(res, { accessToken, refreshToken }, 'Token refreshed successfully');
  } catch (err) {
    logger.error('Refresh Error', err);
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Token refresh failed', ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Logout user
 * POST /auth/logout
 */
export async function logout(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return sendError(res, HttpStatus.UNAUTHORIZED, 'Unauthorized', ErrorCode.UNAUTHORIZED);
    }

    await User.updateOne(
      { _id: userId },
      { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } },
    );

    sendMessage(res, 'Logged out successfully');
  } catch (err) {
    return sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, 'Logout failed', ErrorCode.INTERNAL_ERROR);
  }
}
