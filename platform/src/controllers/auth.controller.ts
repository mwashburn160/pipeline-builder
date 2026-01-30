import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User, Organization } from '../models';
import {
  logger,
  sendError,
  generateTokenPair,
  hashRefreshToken,
} from '../utils';

/**
 * Register a new user
 * POST /auth/register
 */
export async function register(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();
  let result;

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
        const orgData: any = {
          name: isSystemOrg ? 'system' : trimmedOrgName,
          owner: user._id,
          members: [user._id],
        };

        // Set custom _id for system organization
        if (isSystemOrg) {
          orgData._id = 'system';
        }

        const [org] = await Organization.create([orgData], { session });

        user.organizationId = org._id as any;
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

    res.status(201).json({ success: true, statusCode: 201, user: result });
  } catch (err: any) {
    if (err.message === 'MISSING_FIELDS') {
      return sendError(res, 400, 'Missing required fields');
    }
    if (err.message === 'DUPLICATE_CREDENTIALS') {
      return sendError(res, 409, 'Credentials already in use');
    }

    logger.error('Registration Failed', err);
    return sendError(res, 500, 'Registration failed');
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
      return sendError(res, 400, 'Missing required fields');
    }

    const user = await User.findOne({
      $or: [
        { email: identifier.toLowerCase() },
        { username: identifier.toLowerCase() },
      ],
    }).select('+password +tokenVersion');

    if (!user || !(await user.comparePassword(password))) {
      return sendError(res, 401, 'Invalid credentials');
    }

    const { accessToken, refreshToken } = generateTokenPair(user);
    const hashedRefresh = hashRefreshToken(refreshToken);

    await User.updateOne(
      { _id: user._id },
      { $set: { refreshToken: hashedRefresh } },
    );

    res.json({ success: true, statusCode: 200, accessToken, refreshToken });
  } catch (err) {
    logger.error('Login Error', err);
    return sendError(res, 500, 'Login failed');
  }
}

/**
 * Refresh tokens
 * POST /auth/refresh
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const user = await User.findById(req.user.sub);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    const { accessToken, refreshToken } = generateTokenPair(user);
    const hashedRefresh = hashRefreshToken(refreshToken);

    await User.updateOne(
      { _id: user._id },
      { $set: { refreshToken: hashedRefresh } },
    );

    res.json({ success: true, statusCode: 200, accessToken, refreshToken });
  } catch (err) {
    logger.error('Refresh Error', err);
    return sendError(res, 500, 'Renewal failed');
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
      return sendError(res, 401, 'Unauthorized');
    }

    await User.updateOne(
      { _id: userId },
      { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } },
    );

    res.json({ success: true, statusCode: 200, message: 'Logged out' });
  } catch (err) {
    return sendError(res, 500, 'Logout failed');
  }
}
