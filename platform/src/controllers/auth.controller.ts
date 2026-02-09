import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User, Organization } from '../models';
import { logger, sendError, generateTokenPair, hashRefreshToken } from '../utils';

/**
 * Handle known error codes with appropriate responses.
 */
function handleKnownError(res: Response, err: Error, fallbackMessage: string): void {
  const errorMap: Record<string, { status: number; message: string }> = {
    MISSING_FIELDS: { status: 400, message: 'Missing required fields' },
    DUPLICATE_CREDENTIALS: { status: 409, message: 'Credentials already in use' },
  };

  const mapped = errorMap[err.message];
  if (mapped) {
    sendError(res, mapped.status, mapped.message);
  } else {
    sendError(res, 500, fallbackMessage);
  }
}

/**
 * Generate and persist new token pair for user.
 */
async function issueTokens(user: any): Promise<{ accessToken: string; refreshToken: string }> {
  const { accessToken, refreshToken } = generateTokenPair(user);
  const hashedRefresh = hashRefreshToken(refreshToken);

  await User.updateOne({ _id: user._id }, { $set: { refreshToken: hashedRefresh } });

  return { accessToken, refreshToken };
}

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
        $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
      }).session(session);

      if (existing) {
        throw new Error('DUPLICATE_CREDENTIALS');
      }

      const effectiveOrgName = organizationName?.trim().length >= 2
        ? organizationName.trim()
        : username;

      const user = new User({
        username,
        email,
        password,
        role: 'admin',
      });

      const isSystemOrg = effectiveOrgName.toLowerCase() === 'system';

      const orgData: any = {
        name: isSystemOrg ? 'system' : effectiveOrgName,
        owner: user._id,
        members: [user._id],
      };

      if (isSystemOrg) {
        orgData._id = 'system';
        orgData.quotas = { plugins: -1, pipelines: -1, apiCalls: -1 };
      }

      const [org] = await Organization.create([orgData], { session });
      user.organizationId = org._id as any;
      const orgName = org.name;
      const orgId = String(org._id);

      await user.save({ session });

      result = {
        sub: user._id.toString(),
        email: user.email,
        role: user.role,
        organizationId: orgId,
        organizationName: orgName,
      };
    });

    res.status(201).json({ success: true, statusCode: 201, data: { user: result } });
  } catch (err: any) {
    logger.error('Registration Failed', err);
    handleKnownError(res, err, 'Registration failed');
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
      $or: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }],
    }).select('+password +tokenVersion');

    if (!user || !(await user.comparePassword(password))) {
      return sendError(res, 401, 'Invalid credentials');
    }

    const tokens = await issueTokens(user);

    res.json({ success: true, statusCode: 200, data: tokens });
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

    const tokens = await issueTokens(user);

    res.json({ success: true, statusCode: 200, data: tokens });
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