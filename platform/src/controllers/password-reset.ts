// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Forgot-password (services/password-reset-service.ts):
 *
 *   POST /auth/password/reset-request  { email }            → 200, ALWAYS
 *   POST /auth/password/reset          { token, newPassword } → 200 | 400 | 403
 *
 * Both are PRE-AUTH. The request answers 200 with the same message whether or
 * not an email went out, so it can't enumerate accounts; why it didn't (unknown
 * address, no password, SSO-required) is in the audit row and the log only.
 *
 * Audit: `user.password.reset.request` (dispatched, or `outcome: 'failure'` with
 * `details.reason` when skipped and the address named an account),
 * `user.password.reset` on success (refused resets are counted in
 * `platform_password_resets_total{result}` — an invalid token names no
 * account to file a row against). Pre-auth, so `audit(req, …)` would file the row
 * under an anonymous actor — the rows are attributed to the account the email /
 * token resolved to via `createEvent`, like `verifyEmail`. NEVER the token.
 */

import { createLogger, errorMessage, sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { config } from '../config/index.js';
import { withController } from '../helpers/controller-helper.js';
import type { AuditAction } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import { auditService } from '../services/index.js';
import {
  PASSWORD_RESET_SSO_REQUIRED,
  PASSWORD_RESET_TOKEN_INVALID,
  PASSWORD_RESET_UNCHANGED,
  requestPasswordReset,
  resetPassword,
} from '../services/password-reset-service.js';
import { passwordResetRequestSchema, passwordResetSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('password-reset');

/** The one answer the request route ever gives. */
export const RESET_REQUEST_MESSAGE = 'If an account with that email can reset its password, a reset link is on its way.';

function writeAudit(
  req: Request,
  action: AuditAction,
  subject: { userId: string; email?: string; orgId?: string },
  outcome: 'success' | 'failure',
  details: Record<string, unknown> = {},
): void {
  auditService.createEvent({
    action,
    actorId: subject.userId,
    ...(subject.email ? { actorEmail: subject.email } : {}),
    orgId: subject.orgId,
    affectedOrgId: subject.orgId,
    targetType: 'user',
    targetId: subject.userId,
    outcome,
    ip: req.ip,
    details,
  }).catch((err) => logger.warn('Failed to write password-reset audit event', { action, error: errorMessage(err) }));
}

/** POST /auth/password/reset-request */
export const requestReset = withController('Request password reset', async (req, res) => {
  const body = validateBody(passwordResetRequestSchema, req.body, res);
  if (!body) return;

  const outcome = await requestPasswordReset(body.email);
  if (outcome.dispatched) {
    const resetUrl = `${config.app.frontendUrl}/auth/reset-password?token=${outcome.rawToken}`;
    const { emailService } = await import('../utils/email.js');
    const { passwordResetTemplate } = await import('../utils/email-templates.js');
    const sent = await emailService.send({ to: outcome.email, ...passwordResetTemplate(resetUrl, outcome.ttlMinutes) });
    writeAudit(req, 'user.password.reset.request', outcome, sent ? 'success' : 'failure', sent ? {} : { reason: 'email-failed' });
    incCounter('platform_password_reset_requests_total', { result: sent ? 'sent' : 'email_failed' });
  } else {
    if (outcome.userId) {
      writeAudit(req, 'user.password.reset.request', { userId: outcome.userId, orgId: outcome.orgId }, 'failure', { reason: outcome.reason });
    }
    incCounter('platform_password_reset_requests_total', { result: outcome.reason.replace('-', '_') });
  }
  // The same answer on every path — never reveal whether the address exists.
  sendSuccess(res, 200, undefined, RESET_REQUEST_MESSAGE);
});

/** POST /auth/password/reset */
export const confirmReset = withController('Reset password', async (req, res) => {
  const body = validateBody(passwordResetSchema, req.body, res);
  if (!body) return;

  try {
    const result = await resetPassword(body.token, body.newPassword);
    writeAudit(req, 'user.password.reset', result, 'success', { accessKeysRevoked: result.accessKeysRevoked });
    incCounter('platform_password_resets_total', { result: 'reset' });
    sendSuccess(res, 200, { accessKeysRevoked: result.accessKeysRevoked }, 'Password reset. Sign in with your new password.');
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    if (code === PASSWORD_RESET_TOKEN_INVALID) {
      incCounter('platform_password_resets_total', { result: 'invalid_token' });
      return sendError(res, 400, 'This reset link is invalid or has expired. Request a new one.', PASSWORD_RESET_TOKEN_INVALID);
    }
    if (code === PASSWORD_RESET_SSO_REQUIRED) {
      incCounter('platform_password_resets_total', { result: 'sso_required' });
      return sendError(res, 403, 'Your organization requires single sign-on (SSO). Sign in with your organization\'s identity provider instead.', 'SSO_REQUIRED');
    }
    if (code === PASSWORD_RESET_UNCHANGED) {
      return sendError(res, 400, 'Choose a password different from your current one', 'PASSWORD_UNCHANGED');
    }
    // PasswordPolicyServiceError (400 + its own code) and anything unexpected:
    // the shared controller error handler.
    throw err;
  }
});
