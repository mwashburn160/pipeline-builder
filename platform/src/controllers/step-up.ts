// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step-up authentication: re-verify the current user's password before
 * destructive sysadmin actions (grant/revoke platform-admin, rotate KMS,
 * download namespace YAML, etc.).
 *
 *   POST /api/auth/step-up   body: { password: string }
 *
 * Returns 200 on success, 401 on bad password. Doesn't issue a new token —
 * the caller is already authenticated. The frontend pattern is:
 *   1. User clicks a destructive action.
 *   2. UI prompts for password.
 *   3. UI calls POST /step-up. On success, immediately calls the
 *      destructive endpoint. On failure, shows "wrong password" and
 *      doesn't proceed.
 *
 * Returns a short-lived `stepUpToken` JWT (default 60s TTL) bound to
 * `req.user.sub`. The frontend sends it back as the `X-Step-Up-Token`
 * header on the next destructive request; the `requireStepUp` middleware
 * enforces it. Single-use IS enforced via a process-local consumed-jti
 * set (`middleware/consumed-jti.ts`) — a replay against the same process
 * is rejected. Multi-instance deployments get best-effort single-use
 * within each process; swap the consumed-jti module for a Redis-backed
 * implementation when that gap matters.
 *
 * Rate-limited (4 attempts per minute per user) to slow brute-force.
 * Failed attempts are recorded to the audit log so a compromised
 * session shows up.
 */

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit';
import { withController } from '../helpers/controller-helper';
import { User } from '../models';
import { issueStepUpToken } from '../utils/token';

const logger = createLogger('step-up');

/** POST /api/auth/step-up — verify the caller's password. */
export const stepUpVerify = withController('Step-up password verify', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, 'Authentication required');

  const password = (req.body as { password?: unknown })?.password;
  if (typeof password !== 'string' || password.length === 0) {
    return sendError(res, 400, 'password is required');
  }

  // `+password` selects the field that's normally `select: false` so we
  // can call comparePassword on it.
  const user = await User.findById(userId).select('+password email');
  if (!user) return sendError(res, 401, 'Authentication required');

  const ok = await user.comparePassword(password);
  if (!ok) {
    // Audit the failure so compromised-session anomalies show up. We
    // never log the attempted password.
    audit(req, 'user.login.failed', {
      targetType: 'step-up',
      targetId: userId,
      outcome: 'failure',
      details: { reason: 'invalid-password' },
    });
    logger.warn('Step-up password verify failed', { userId });
    return sendError(res, 401, 'Invalid password');
  }

  const { token, expiresAt } = issueStepUpToken(userId);
  sendSuccess(res, 200, { ok: true, stepUpToken: token, expiresAt });
});
