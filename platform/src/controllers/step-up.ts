// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step-up authentication: re-verify the current user before destructive or
 * credential-minting actions (grant/revoke platform-admin, rotate KMS, download
 * namespace YAML, create tokens, etc.).
 *
 * Every method issues the same kind of token:
 *   POST /api/auth/step-up                  body: { password }   (this file)
 *   POST /api/auth/step-up/reauth           + /reauth/callback   (provider
 *     re-auth for OAuth/SSO accounts — controllers/step-up-reauth.ts)
 *   POST /api/auth/step-up/webauthn/*       (passkey — controllers/webauthn.ts)
 *   POST /api/auth/step-up/totp             (authenticator app — controllers/totp.ts)
 * The token records `method` ('password' | 'reauth' | 'webauthn' | 'totp'); a
 * route gated by `requireStepUp({ methods: STRONG_STEP_UP_METHODS })` admits
 * only the passkey and authenticator-app ones.
 *
 * Returns 200 with a short-lived `stepUpToken` JWT (default 60s TTL) bound to
 * `req.user.sub`, or 401 on a bad password. The frontend pattern is:
 *   1. User clicks a destructive action.
 *   2. UI prompts for password and calls POST /auth/step-up.
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

import { createLogger, ErrorCode, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import {
  completePasswordAttempt,
  PASSWORD_LOCKOUT_MESSAGE,
  PasswordLockedOutError,
  recordPasswordFailure,
  releasePasswordAttempt,
  reservePasswordAttempt,
  type PasswordAttempt,
} from '../helpers/password-lockout.js';
import { User } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import { issueStepUpToken } from '../services/session/access-tokens.js';

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

  // The SAME durable per-account lockout password sign-in uses
  // (helpers/password-lockout.ts). Without it this route is a password oracle
  // that a stolen access token could query past a live sign-in lockout, and
  // its only other throttle (the Redis limiter) fails open when Redis errors.
  let attempt: PasswordAttempt;
  try {
    attempt = await reservePasswordAttempt(userId);
  } catch (err) {
    if (err instanceof PasswordLockedOutError) return refuseLocked(res, err);
    throw err;
  }
  let ok: boolean;
  try {
    ok = await user.comparePassword(password);
  } catch (err) {
    await releasePasswordAttempt(attempt).catch(() => undefined);
    throw err;
  }
  if (ok) {
    try {
      await completePasswordAttempt(attempt);
    } catch (err) {
      if (err instanceof PasswordLockedOutError) return refuseLocked(res, err);
      throw err;
    }
  } else {
    await recordPasswordFailure(userId, attempt.reservationId);
  }
  if (!ok) {
    // Audit the failure so compromised-session anomalies show up. We
    // never log the attempted password.
    audit(req, 'user.login.failed', {
      targetType: 'step-up',
      targetId: userId,
      outcome: 'failure',
      details: { reason: 'invalid-password', method: 'password' },
    });
    incCounter('platform_step_up_total', { method: 'password', outcome: 'failure' });
    logger.warn('Step-up password verify failed', { userId });
    return sendError(res, 401, 'Invalid password', ErrorCode.INVALID_CREDENTIALS);
  }

  const { token, expiresAt } = await issueStepUpToken(userId, 'password');
  audit(req, 'user.step-up', { targetType: 'user', targetId: userId, details: { method: 'password' } });
  incCounter('platform_step_up_total', { method: 'password', outcome: 'success' });
  // One response shape for every factor: the token plus how it was earned.
  sendSuccess(res, 200, { ok: true, stepUpToken: token, expiresAt, method: 'password' });
});

/** The lockout's own 429 — the same answer password sign-in gives. */
function refuseLocked(res: Parameters<typeof sendError>[0], err: PasswordLockedOutError): void {
  incCounter('platform_step_up_total', { method: 'password', outcome: 'failure' });
  res.setHeader('Retry-After', String(err.retryAfterSeconds));
  sendError(res, 429, PASSWORD_LOCKOUT_MESSAGE, ErrorCode.RATE_LIMIT_EXCEEDED, { retryAfterSeconds: err.retryAfterSeconds });
}
