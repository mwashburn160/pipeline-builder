// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, createSafeClient, getServiceAuthHeader, isSystemOrgId } from '@pipeline-builder/api-core';
import { config } from '../config';
import { audit } from '../helpers/audit';
import { withController } from '../helpers/controller-helper';
import { incCounter } from '../observability/metrics';
import { authService, DUPLICATE_CREDENTIALS } from '../services';
import { issueTokens } from '../utils/token';
import { validateBody, registerSchema, loginSchema, refreshSchema } from '../utils/validation';

const logger = createLogger('auth-controller');

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
  // isSystemOrgId checks BOTH id and name so a system-named org with an
  // ObjectId id (or vice-versa) is still recognised.
  const isSystem = isSystemOrgId(result.organizationId, result.organizationName);

  if (config.billing.enabled) {
    void createBillingSubscription(result.organizationId, result.planId || 'developer');
  }
  if (config.compliance.enabled && !isSystem) {
    void autoSubscribeToPublishedRules(result.organizationId);
  }

  // Auto-promote if the new user's email is in BOOTSTRAP_SUPERADMIN_EMAILS.
  // Awaited (not fire-and-forget) so a register-then-immediately-login flow
  // doesn't outrun the promotion — otherwise the first JWT carries
  // isSuperAdmin=false and the user hits "Forbidden: System admin access
  // required" on the dashboard until the next login (or restart-time bootstrap).
  // Promotion failure is logged but not fatal — startup bootstrap retries it.
  if (result.sub && result.email) {
    const { maybePromoteNewUser } = await import('../services/superadmin-bootstrap.js');
    try {
      await maybePromoteNewUser(result.sub, result.email);
    } catch (err) {
      logger.warn('Super-admin promotion failed (non-fatal — startup bootstrap will retry)', {
        userId: result.sub,
        email: result.email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  if (!user) {
    // Emit a failed-login audit + counter so brute-force / credential-stuffing
    // attempts are visible to security teams + the Platform Overview
    // dashboard. Captures `identifier` (not the password) — same shape
    // as a typical SIEM auth-failure signal.
    audit(req, 'user.login.failed', { targetType: 'user', details: { identifier: body.identifier } });
    incCounter('platform_logins_failed_total');
    return sendError(res, 401, 'Invalid credentials');
  }

  const tokens = await issueTokens(user, user.lastActiveOrgId?.toString());

  audit(req, 'user.login', { targetType: 'user', targetId: user._id.toString() });
  // Counter consumed by the Platform Overview dashboard's "logins/min" panel.
  incCounter('platform_logins_total');
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

  sendSuccess(res, 200, tokens);
});

/** Logout user — bumps tokenVersion + clears refresh token. POST /auth/logout */
export const logout = withController('Logout', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, 'Unauthorized');

  await authService.invalidateAllSessions(userId);

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
  const { verifyEmailTemplate } = await import('../utils/email-templates.js');

  // Routes through the templated email pipeline: HTML body is escape-safe,
  // wrapped in the shared layout, and the text variant is built from a
  // template file rather than inline-string concatenation.
  await emailService.send({
    to: dispatch.email,
    ...verifyEmailTemplate(verifyUrl),
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
