// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step-up authentication: re-verify the current user's password before
 * destructive or credential-minting actions (grant/revoke platform-admin, rotate
 * KMS, download namespace YAML, create tokens, etc.).
 *
 *   POST /api/auth/step-up   body: { password: string }
 *
 * Returns 200 with a short-lived `stepUpToken` JWT (default 60s TTL) bound to
 * `req.user.sub`, or 401 on a bad password. The frontend pattern is:
 *   1. User clicks a destructive action.
 *   2. UI prompts for password and calls POST /step-up.
 *   3. UI sends the token as `X-Step-Up-Token` on the destructive request.
 *
 * api-core's `requireStepUp` enforces it on every gated route (platform's
 * included): caller-bound, single-use across replicas when Redis is configured
 * (a Redis error fails closed), service principals exempt.
 *
 * Rate-limited (5 attempts per minute per user) to slow brute-force.
 * Failed attempts are recorded to the audit log so a compromised
 * session shows up.
 */

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import { User } from '../models/index.js';
import { issueStepUpToken } from '../utils/token.js';

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
