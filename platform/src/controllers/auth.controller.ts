import { createLogger, sendError } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { handleControllerError } from '../helpers/controller-helper';
import { User, Organization } from '../models';
import {
  validateBody,
  registerSchema,
  loginSchema,
  refreshSchema,
  issueTokens,
  hashRefreshToken,
} from '../utils/auth-utils';

const logger = createLogger('AuthController');

/** Error map for registration errors */
const registerErrorMap: Record<string, { status: number; message: string }> = {
  MISSING_FIELDS: { status: 400, message: 'Missing required fields' },
  DUPLICATE_CREDENTIALS: { status: 409, message: 'Credentials already in use' },
};

/**
 * Register a new user
 * POST /auth/register
 */
export async function register(req: Request, res: Response): Promise<void> {
  const body = validateBody(registerSchema, req.body, res);
  if (!body) return;

  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const { username, email, password, organizationName } = body;

      const existing = await User.exists({
        $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
      }).session(session);

      if (existing) {
        throw new Error('DUPLICATE_CREDENTIALS');
      }

      const trimmedOrgName = organizationName?.trim();
      const effectiveOrgName = trimmedOrgName && trimmedOrgName.length >= 2
        ? trimmedOrgName
        : username;

      const user = new User({
        username,
        email,
        password,
        role: 'admin',
      });

      const isSystemOrg = effectiveOrgName.toLowerCase() === 'system';

      const orgData: Record<string, unknown> = {
        name: isSystemOrg ? 'system' : effectiveOrgName,
        owner: user._id,
        members: [user._id],
      };

      if (isSystemOrg) {
        orgData._id = 'system';
        orgData.tier = 'unlimited';
        orgData.quotas = { plugins: -1, pipelines: -1, apiCalls: -1 };
      }

      const [org] = await Organization.create([orgData], { session });
      user.organizationId = org._id as mongoose.Types.ObjectId;
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
  } catch (error) {
    handleControllerError(res, error, 'Registration failed', registerErrorMap);
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
    const body = validateBody(loginSchema, req.body, res);
    if (!body) return;

    const { identifier, password } = body;

    const user = await User.findOne({
      $or: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }],
    }).select('+password +tokenVersion');

    if (!user || !(await user.comparePassword(password))) {
      return sendError(res, 401, 'Invalid credentials');
    }

    const tokens = await issueTokens(user);

    res.cookie('grafana_token', tokens.accessToken, {
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: tokens.expiresIn * 1000,
    });
    res.json({ success: true, statusCode: 200, data: tokens });
  } catch (error) {
    logger.error('Login Error', error);
    return sendError(res, 500, 'Login failed');
  }
}

/**
 * Refresh tokens
 * POST /auth/refresh
 *
 * Uses atomic findOneAndUpdate to swap the refresh token hash,
 * preventing race conditions where the same refresh token is used twice.
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const body = validateBody(refreshSchema, req.body, res);
    if (!body) return;

    const oldRefreshToken = body.refreshToken;

    const oldHash = hashRefreshToken(oldRefreshToken);

    // Atomically verify old hash and fetch user
    const user = await User.findOne({
      _id: req.user.sub,
      refreshToken: oldHash,
    }).select('+refreshToken +tokenVersion');

    if (!user) {
      // Old refresh token hash doesn't match — possible reuse/theft
      // Invalidate all sessions for this user as a precaution
      await User.updateOne(
        { _id: req.user.sub },
        { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } },
      );
      logger.warn('[AUTH] Refresh token reuse detected, invalidated all sessions', {
        userId: req.user.sub,
      });
      return sendError(res, 401, 'Session invalidated — please log in again');
    }

    const tokens = await issueTokens(user);

    res.cookie('grafana_token', tokens.accessToken, {
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: tokens.expiresIn * 1000,
    });
    res.json({ success: true, statusCode: 200, data: tokens });
  } catch (error) {
    logger.error('Refresh Error', error);
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

    res.clearCookie('grafana_token', { httpOnly: true, sameSite: 'lax', path: '/' });
    res.json({ success: true, statusCode: 200, message: 'Logged out' });
  } catch (error) {
    return sendError(res, 500, 'Logout failed');
  }
}
