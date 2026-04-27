// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createLogger, sendError, sendSuccess, createSafeClient, getServiceAuthHeader, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { config } from '../config';
import { audit } from '../helpers/audit';
import { withController } from '../helpers/controller-helper';
import { User, Organization, UserOrganization } from '../models';
import { issueTokens, hashRefreshToken } from '../utils/token';
import { validateBody, registerSchema, loginSchema, refreshSchema } from '../utils/validation';

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
      headers: {
        'x-org-id': orgId,
        authorization: getServiceAuthHeader({ serviceName: 'platform', orgId }),
      },
    });

    logger.info('Billing subscription created for new org', { orgId, planId });
  } catch (error) {
    // Fail-open: don't block registration if billing is unavailable
    logger.warn('Failed to create billing subscription (non-blocking)', { orgId, planId, error });
  }
}

/** Auto-subscribe a new org to all published compliance rules (inactive, fire-and-forget). */
async function autoSubscribeToPublishedRules(orgId: string): Promise<void> {
  try {
    const client = createSafeClient({
      host: config.compliance.serviceHost,
      port: config.compliance.servicePort,
      timeout: config.compliance.serviceTimeout,
    });

    await client.post('/compliance/subscriptions/auto-subscribe', {}, {
      headers: {
        'x-org-id': orgId,
        authorization: getServiceAuthHeader({ serviceName: 'platform', orgId }),
      },
    });

    logger.info('Auto-subscribed org to published compliance rules', { orgId });
  } catch (error) {
    // Fail-open: don't block registration if compliance is unavailable
    logger.warn('Failed to auto-subscribe to published rules (non-blocking)', { orgId, error });
  }
}

/** Maps internal registration error codes to HTTP status and user-facing message. */
const registerErrorMap: Record<string, { status: number; message: string }> = {
  MISSING_FIELDS: { status: 400, message: 'Missing required fields' },
  DUPLICATE_CREDENTIALS: { status: 409, message: 'Credentials already in use' },
};

/**
 * Register a new user.
 * POST /auth/register
 *
 * Creates a User, an Organization, and a {@link UserOrganization} record
 * linking the user to the new org with role 'owner'. Sets the user's
 * `lastActiveOrgId` to the new organization. Fire-and-forget hooks
 * create a billing subscription and auto-subscribe to compliance rules.
 */
export const register = withController('Register', async (req, res) => {
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
      });

      const isSystemOrg = effectiveOrgName.toLowerCase() === SYSTEM_ORG_ID;

      const orgData: Record<string, unknown> = {
        name: isSystemOrg ? SYSTEM_ORG_ID : effectiveOrgName,
        owner: user._id,
      };

      if (isSystemOrg) {
        orgData._id = SYSTEM_ORG_ID;
        orgData.tier = 'unlimited';
        orgData.quotas = { plugins: -1, pipelines: -1, apiCalls: -1 };
      }

      const [org] = await Organization.create([orgData], { session });
      const orgId = String(org._id);

      // Create membership in junction collection
      await UserOrganization.create([{
        userId: user._id,
        organizationId: org._id,
        role: 'owner',
      }], { session });

      user.lastActiveOrgId = org._id as mongoose.Types.ObjectId;
      await user.save({ session });

      result = {
        sub: user._id.toString(),
        email: user.email,
        role: 'owner',
        organizationId: orgId,
        organizationName: org.name,
        planId: isSystemOrg ? 'unlimited' : (planId || 'developer'),
      };
    });

    // Post-registration hooks (fire-and-forget)
    if (result) {
      const orgId = (result as Record<string, string>).organizationId;
      const isSystem = orgId === SYSTEM_ORG_ID;

      if (config.billing.enabled) {
        const selectedPlan = (result as Record<string, string>).planId || 'developer';
        void createBillingSubscription(orgId, selectedPlan);
      }

      // Auto-subscribe sub-orgs to published compliance rules (inactive by default)
      if (config.compliance.enabled && !isSystem) {
        void autoSubscribeToPublishedRules(orgId);
      }

      audit(req, 'user.register', { targetType: 'user', targetId: (result as Record<string, string>).sub });
    }
    sendSuccess(res, 201, { user: result });
  } finally {
    await session.endSession();
  }
}, registerErrorMap);

/**
 * Login user.
 * POST /auth/login
 *
 * Authenticates by email/username + password. Issues tokens scoped to
 * the user's last active organization (resolved via {@link UserOrganization}).
 * The JWT `role` field reflects the user's role in that organization.
 */
export const login = withController('Login', async (req, res) => {
  const body = validateBody(loginSchema, req.body, res);
  if (!body) return;

  const { identifier, password } = body;

  const user = await User.findOne({
    $or: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }],
  }).select('+password +tokenVersion');

  if (!user || !(await user.comparePassword(password))) {
    return sendError(res, 401, 'Invalid credentials');
  }

  const tokens = await issueTokens(user, user.lastActiveOrgId?.toString());

  res.cookie('grafana_token', tokens.accessToken, {
    httpOnly: true, secure: config.auth.cookie.secure, sameSite: config.auth.cookie.sameSite, path: '/', maxAge: tokens.expiresIn * 1000,
  });
  audit(req, 'user.login', { targetType: 'user', targetId: user._id.toString() });
  sendSuccess(res, 200, tokens);
});

/**
 * Refresh tokens
 * POST /auth/refresh
 *
 * Uses atomic findOneAndUpdate to swap the refresh token hash,
 * preventing race conditions where the same refresh token is used twice.
 */
export const refresh = withController('Refresh', async (req, res) => {
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

  // Preserve active org from current JWT; fall back to lastActiveOrgId
  const activeOrgId = req.user.organizationId || user.lastActiveOrgId?.toString();
  const tokens = await issueTokens(user, activeOrgId);

  res.cookie('grafana_token', tokens.accessToken, {
    httpOnly: true, secure: config.auth.cookie.secure, sameSite: config.auth.cookie.sameSite, path: '/', maxAge: tokens.expiresIn * 1000,
  });
  sendSuccess(res, 200, tokens);
});

/**
 * Logout user
 * POST /auth/logout
 */
export const logout = withController('Logout', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) {
    return sendError(res, 401, 'Unauthorized');
  }

  await User.updateOne(
    { _id: userId },
    { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } },
  );

  res.clearCookie('grafana_token', { httpOnly: true, secure: config.auth.cookie.secure, sameSite: config.auth.cookie.sameSite, path: '/' });
  audit(req, 'user.logout');
  sendSuccess(res, 200, undefined, 'Logged out');
});

/**
 * Switch active organization.
 * POST /auth/switch-org
 *
 * Verifies the user has an active {@link UserOrganization} membership
 * for the requested org, updates `User.lastActiveOrgId`, and re-issues
 * tokens with the new org context. The JWT `role` and `isAdmin` fields
 * will reflect the user's role in the target organization.
 */
export const switchOrg = withController('Switch org', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, 'Unauthorized');

  const { organizationId } = req.body;
  if (!organizationId) return sendError(res, 400, 'organizationId is required');

  // Verify membership
  const membership = await UserOrganization.findOne({ userId, organizationId, isActive: true }).lean();
  if (!membership) {
    return sendError(res, 403, 'You are not an active member of this organization');
  }

  // Update last active org
  await User.updateOne({ _id: userId }, { $set: { lastActiveOrgId: organizationId } });

  // Re-fetch user for token issuance
  const user = await User.findById(userId).select('+tokenVersion');
  if (!user) return sendError(res, 404, 'User not found');

  const tokens = await issueTokens(user, organizationId);

  res.cookie('grafana_token', tokens.accessToken, {
    httpOnly: true, secure: config.auth.cookie.secure, sameSite: config.auth.cookie.sameSite, path: '/', maxAge: tokens.expiresIn * 1000,
  });
  sendSuccess(res, 200, tokens);
});

// Email Verification

/** Token validity period (24 hours). */
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * POST /auth/send-verification
 * Send (or re-send) an email verification link to the authenticated user.
 */
export const sendVerificationEmail = withController('Send verification email', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, 'Unauthorized');

  const user = await User.findById(userId).select('+emailVerificationToken +emailVerificationExpires');
  if (!user) return sendError(res, 404, 'User not found');

  if (user.isEmailVerified) {
    return sendSuccess(res, 200, undefined, 'Email already verified');
  }

  // Generate token
  const token = crypto.randomBytes(32).toString('hex');
  user.emailVerificationToken = crypto.createHash('sha256').update(token).digest('hex');
  user.emailVerificationExpires = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
  await user.save();

  // Send verification email
  const verifyUrl = `${config.app.frontendUrl}/auth/verify-email?token=${token}`;
  const { emailService } = await import('../utils/email.js');

  await emailService.send({
    to: user.email,
    subject: 'Verify your email address',
    text: `Click this link to verify your email: ${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: `<p>Click the link below to verify your email address:</p><p><a href="${verifyUrl}">Verify Email</a></p><p>This link expires in 24 hours.</p>`,
  });

  logger.info('[AUTH] Verification email sent', { userId, email: user.email });
  sendSuccess(res, 200, undefined, 'Verification email sent');
});

/**
 * POST /auth/verify-email
 * Verify email address using token from the verification link.
 * Body: { token: string }
 */
export const verifyEmail = withController('Verify email', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return sendError(res, 400, 'Verification token is required');
  }

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpires: { $gt: new Date() },
  }).select('+emailVerificationToken +emailVerificationExpires');

  if (!user) {
    return sendError(res, 400, 'Invalid or expired verification token');
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  logger.info('[AUTH] Email verified', { userId: user._id, email: user.email });
  sendSuccess(res, 200, undefined, 'Email verified successfully');
});
