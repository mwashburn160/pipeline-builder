// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, createSafeClient, getServiceAuthHeader, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { config } from '../config';
import { audit } from '../helpers/audit';
import { withController } from '../helpers/controller-helper';
import { authService, DUPLICATE_CREDENTIALS } from '../services';
import { issueTokens } from '../utils/token';
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
        'authorization': getServiceAuthHeader({ serviceName: 'platform', orgId }),
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
        'authorization': getServiceAuthHeader({ serviceName: 'platform', orgId }),
      },
    });

    logger.info('Auto-subscribed org to published compliance rules', { orgId });
  } catch (error) {
    // Fail-open: don't block registration if compliance is unavailable
    logger.warn('Failed to auto-subscribe to published rules (non-blocking)', { orgId, error });
  }
}

/**
 * Register a new user.
 * POST /auth/register
 *
 * AuthService runs the User+Organization+UserOrganization transaction;
 * fire-and-forget hooks here create a billing subscription and
 * auto-subscribe to compliance rules.
 */
export const register = withController('Register', async (req, res) => {
  const body = validateBody(registerSchema, req.body, res);
  if (!body) return;

  const result = await authService.register(body);
  const isSystem = result.organizationId === SYSTEM_ORG_ID;

  if (config.billing.enabled) {
    void createBillingSubscription(result.organizationId, result.planId || 'developer');
  }
  if (config.compliance.enabled && !isSystem) {
    void autoSubscribeToPublishedRules(result.organizationId);
  }

  audit(req, 'user.register', { targetType: 'user', targetId: result.sub });
  sendSuccess(res, 201, { user: result });
}, {
  [DUPLICATE_CREDENTIALS]: { status: 409, message: 'Credentials already in use' },
  MISSING_FIELDS: { status: 400, message: 'Missing required fields' },
});

/** Login user. POST /auth/login */
export const login = withController('Login', async (req, res) => {
  const body = validateBody(loginSchema, req.body, res);
  if (!body) return;

  const user = await authService.findByCredentials(body.identifier, body.password);
  if (!user) return sendError(res, 401, 'Invalid credentials');

  const tokens = await issueTokens(user, user.lastActiveOrgId?.toString());

  res.cookie('grafana_token', tokens.accessToken, {
    httpOnly: true, secure: config.auth.cookie.secure, sameSite: config.auth.cookie.sameSite, path: '/', maxAge: tokens.expiresIn * 1000,
  });
  audit(req, 'user.login', { targetType: 'user', targetId: user._id.toString() });
  sendSuccess(res, 200, tokens);
});

/**
 * Refresh tokens. POST /auth/refresh
 *
 * AuthService does an atomic findOne against the old refresh-token hash
 * to prevent reuse races; on miss we invalidate every session for the
 * user as a defense against token theft.
 */
export const refresh = withController('Refresh', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Unauthorized');

  const body = validateBody(refreshSchema, req.body, res);
  if (!body) return;

  const user = await authService.rotateRefreshToken(req.user.sub, body.refreshToken);
  if (!user) {
    await authService.invalidateAllSessions(req.user.sub);
    logger.warn('Refresh token reuse detected, invalidated all sessions', { userId: req.user.sub });
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

/** Logout user — bumps tokenVersion + clears refresh token. POST /auth/logout */
export const logout = withController('Logout', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, 'Unauthorized');

  await authService.invalidateAllSessions(userId);

  res.clearCookie('grafana_token', { httpOnly: true, secure: config.auth.cookie.secure, sameSite: config.auth.cookie.sameSite, path: '/' });
  audit(req, 'user.logout');
  sendSuccess(res, 200, undefined, 'Logged out');
});

/** Switch active organization. POST /auth/switch-org */
export const switchOrg = withController('Switch org', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, 'Unauthorized');

  const { organizationId } = req.body;
  if (!organizationId) return sendError(res, 400, 'organizationId is required');

  const user = await authService.switchActiveOrg(userId, organizationId);
  if (!user) return sendError(res, 403, 'You are not an active member of this organization');

  const tokens = await issueTokens(user, organizationId);

  res.cookie('grafana_token', tokens.accessToken, {
    httpOnly: true, secure: config.auth.cookie.secure, sameSite: config.auth.cookie.sameSite, path: '/', maxAge: tokens.expiresIn * 1000,
  });
  sendSuccess(res, 200, tokens);
});

/**
 * POST /auth/send-verification
 * Send (or re-send) an email verification link to the authenticated user.
 */
export const sendVerificationEmail = withController('Send verification email', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, 'Unauthorized');

  const dispatch = await authService.createVerificationToken(userId);
  if (!dispatch) return sendError(res, 404, 'User not found');
  if (dispatch.alreadyVerified) {
    return sendSuccess(res, 200, undefined, 'Email already verified');
  }

  const verifyUrl = `${config.app.frontendUrl}/auth/verify-email?token=${dispatch.rawToken}`;
  const { emailService } = await import('../utils/email.js');

  await emailService.send({
    to: dispatch.email,
    subject: 'Verify your email address',
    text: `Click this link to verify your email: ${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: `<p>Click the link below to verify your email address:</p><p><a href="${verifyUrl}">Verify Email</a></p><p>This link expires in 24 hours.</p>`,
  });

  logger.info('Verification email sent', { userId, email: dispatch.email });
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

  const user = await authService.verifyEmailWithToken(token);
  if (!user) return sendError(res, 400, 'Invalid or expired verification token');

  sendSuccess(res, 200, undefined, 'Email verified successfully');
});
