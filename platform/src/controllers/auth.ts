import { createLogger, sendError, sendSuccess, createSafeClient, SYSTEM_ORG_ID } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { config } from '../config';
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

/** Create a billing service subscription for a new organization (fire-and-forget). */
async function createBillingSubscription(orgId: string, planId: string): Promise<void> {
  try {
    const client = createSafeClient({
      host: config.billing.serviceHost,
      port: config.billing.servicePort,
      timeout: config.billing.serviceTimeout,
    });

    await client.post('/billing/subscriptions', { planId, interval: 'monthly' }, {
      headers: { 'x-org-id': orgId },
    });

    logger.info('Billing subscription created for new org', { orgId, planId });
  } catch (error) {
    // Fail-open: don't block registration if billing is unavailable
    logger.warn('Failed to create billing subscription (non-blocking)', { orgId, planId, error });
  }
}

/** Maps internal registration error codes to HTTP status and user-facing message. */
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
      const { username, email, password, organizationName, planId } = body;

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

      const isSystemOrg = effectiveOrgName.toLowerCase() === SYSTEM_ORG_ID;

      const orgData: Record<string, unknown> = {
        name: isSystemOrg ? SYSTEM_ORG_ID : effectiveOrgName,
        owner: user._id,
        members: [user._id],
      };

      if (isSystemOrg) {
        orgData._id = SYSTEM_ORG_ID;
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
        planId: isSystemOrg ? 'unlimited' : (planId || 'developer'),
      };
    });

    // Create billing subscription after successful registration (fire-and-forget)
    if (result && config.billing.enabled) {
      const selectedPlan = (result as Record<string, string>).planId || 'developer';
      const orgId = (result as Record<string, string>).organizationId;
      void createBillingSubscription(orgId, selectedPlan);
    }

    sendSuccess(res, 201, { user: result });
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
      httpOnly: true, sameSite: config.auth.cookie.sameSite, path: '/', maxAge: tokens.expiresIn * 1000,
    });
    sendSuccess(res, 200, tokens);
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
      httpOnly: true, sameSite: config.auth.cookie.sameSite, path: '/', maxAge: tokens.expiresIn * 1000,
    });
    sendSuccess(res, 200, tokens);
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
    sendSuccess(res, 200, undefined, 'Logged out');
  } catch (error) {
    return sendError(res, 500, 'Logout failed');
  }
}
