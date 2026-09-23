// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticator-app codes (TOTP) — the HTTP surface. All of the rules live in
 * `services/totp-service.ts`; this file validates, audits, meters and maps
 * errors.
 *
 *   GET    /auth/totp/status
 *   POST   /auth/totp/enrol                (step-up + interactive session)
 *   POST   /auth/totp/activate
 *   DELETE /auth/totp                      (step-up + interactive session)
 *   POST   /auth/step-up/totp              — the standard step-up token
 *   POST   /auth/mfa/verify                (public) — finish a password sign-in
 *
 * Recovery codes belong to the account, not to this factor — they are managed
 * at `/auth/recovery-codes` (controllers/recovery-codes.ts).
 *
 * Gating mirrors passkeys exactly, and for the same reason: enrolling or
 * removing TOTP changes what it takes to get into the account, so both take a
 * fresh step-up AND a session the person opened themselves — never an API key, a
 * scoped machine token or an impersonated session.
 *
 * The sign-in leg is the one asymmetry. `POST /auth/login` now answers an
 * MFA account with a challenge instead of a session, and `/auth/mfa/verify`
 * trades that challenge plus a code for the session the login would have opened
 * — public by construction, exactly like `/auth/login` itself.
 */

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { closeBootstrapExceptionOnEnrolment } from '../helpers/bootstrap-admin.js';
import { withController } from '../helpers/controller-helper.js';
import { MFA_POLICY_ERROR_MAP } from '../helpers/mfa-policy.js';
import { completeInteractiveSignIn } from '../helpers/sign-in.js';
import { rejectIfSsoEnforced } from '../helpers/sso-enforcement.js';
import { incCounter } from '../observability/metrics.js';
import { authService } from '../services/index.js';
import { claimMfaChallenge, restoreMfaChallenge } from '../services/mfa-challenge.js';
import { clearMfaNudgeOnEnrolment, clearResetGraceOnEnrolment } from '../services/mfa-enrolment.js';
import { verifyRecoveryCode } from '../services/recovery-codes-service.js';
import { issueStepUpToken, signInAuth } from '../services/session/access-tokens.js';
import { TOTP_ERROR_MAP, TOTP_INVALID_CHALLENGE, TOTP_LOCKED_OUT } from '../services/totp-errors.js';
import * as totp from '../services/totp-service.js';
import { mfaVerifySchema, totpCodeSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('totp');

/** Every verification outcome, by where it happened and how it ended — so a
 *  spike in refusals is visible without reading the audit log. */
function meter(stage: 'activate' | 'stepup' | 'login', outcome: 'success' | 'recovery' | 'failure' | 'locked'): void {
  incCounter('platform_totp_verifications_total', { stage, outcome });
}

/** The outcome label a thrown sentinel maps to. */
function outcomeOf(err: unknown): 'failure' | 'locked' {
  return err instanceof Error && err.message === TOTP_LOCKED_OUT ? 'locked' : 'failure';
}

// -- Management ---------------------------------------------------------------

/** GET /auth/totp/status — whether the caller has an authenticator app, and how
 *  many recovery codes are left. Never the secret. */
export const totpStatus = withController('TOTP status', async (req, res) => {
  sendSuccess(res, 200, { totp: await totp.getStatus(req.user!.sub) });
}, TOTP_ERROR_MAP);

/**
 * POST /auth/totp/enrol — mint a secret and return what the authenticator needs.
 *
 * The response carries the secret in CLEAR TEXT, once: that is unavoidable (the
 * person has to get it into their app) and is why the route is step-up gated,
 * interactive-session only, and never logged.
 */
export const enrolTotp = withController('TOTP enrol', async (req, res) => {
  const userId = req.user!.sub;
  const enrolment = await totp.beginEnrolment(userId);
  audit(req, 'user.totp.enrol', {
    targetType: 'user',
    targetId: userId,
    details: { stage: 'started' },
  });
  sendSuccess(res, 200, enrolment);
}, TOTP_ERROR_MAP);

/**
 * POST /auth/totp/activate — confirm the enrolment with a code and hand back the
 * recovery codes.
 *
 * NOT step-up gated a second time: the pending secret it confirms was minted by
 * the gated call, belongs to this user, and is useless without the code the
 * caller is presenting. A second prompt here would cost a step-up and buy
 * nothing — the same reasoning as `webauthn/register/verify`.
 */
export const activateTotp = withController('TOTP activate', async (req, res) => {
  const userId = req.user!.sub;
  const body = validateBody(totpCodeSchema, req.body, res);
  if (!body) return;

  let result;
  try {
    result = await totp.activate(userId, body.code);
  } catch (err) {
    audit(req, 'user.login.failed', {
      targetType: 'user',
      targetId: userId,
      outcome: 'failure',
      details: { method: 'totp', stage: 'activate', reason: err instanceof Error ? err.message : 'unknown' },
    });
    meter('activate', outcomeOf(err));
    throw err;
  }

  audit(req, 'user.totp.enrol', {
    targetType: 'user',
    targetId: userId,
    details: { stage: 'activated', recoveryCodesMinted: result.recoveryCodes.length },
  });
  await clearResetGraceOnEnrolment(userId);
  // ...and so does any "not now" / "don't ask again" they gave the
  // password-only prompt: it was a decision about an account with no factor.
  await clearMfaNudgeOnEnrolment(userId);
  // A factor now exists, so the bootstrap-admin MFA exception closes — for
  // good, even if this authenticator is later removed. Awaited, not
  // fire-and-forget: the very next request may be the one that must no longer be
  // limited, and the write is a single conditional update.
  await closeBootstrapExceptionOnEnrolment(req, userId);
  meter('activate', 'success');
  // Recovery codes are minted only with the account's FIRST factor, and shown
  // ONCE (only their hashes are stored). An account that already had a set —
  // from a passkey — keeps it and gets an empty list here.
  sendSuccess(res, 201, { recoveryCodes: result.recoveryCodes });
}, TOTP_ERROR_MAP);

/** DELETE /auth/totp — turn the authenticator off (step-up gated). */
export const disableTotp = withController('TOTP disable', async (req, res) => {
  const userId = req.user!.sub;
  await totp.disable(userId);
  audit(req, 'user.totp.disable', { targetType: 'user', targetId: userId });
  sendSuccess(res, 200, { disabled: true });
}, TOTP_ERROR_MAP);

// -- Step-up ------------------------------------------------------------------

/** POST /auth/step-up/totp — earn the standard step-up token with a code. */
export const stepUpVerifyTotp = withController('TOTP step-up verify', async (req, res) => {
  const userId = req.user!.sub;
  const body = validateBody(totpCodeSchema, req.body, res);
  if (!body) return;

  let verification;
  try {
    verification = await totp.verifyCode(userId, body.code);
  } catch (err) {
    audit(req, 'user.login.failed', {
      targetType: 'step-up',
      targetId: userId,
      outcome: 'failure',
      details: { method: 'totp', reason: err instanceof Error ? err.message : 'unknown' },
    });
    incCounter('platform_step_up_total', { method: 'totp', outcome: 'failure' });
    meter('stepup', outcomeOf(err));
    throw err;
  }

  if (verification.method === 'recovery') auditRecoveryUsed(req, userId, 'step-up', verification.recoveryCodesRemaining);

  const { token, expiresAt } = await issueStepUpToken(userId, 'totp');
  audit(req, 'user.step-up', {
    targetType: 'user',
    targetId: userId,
    details: { method: 'totp', via: verification.method },
  });
  incCounter('platform_step_up_total', { method: 'totp', outcome: 'success' });
  meter('stepup', verification.method === 'recovery' ? 'recovery' : 'success');
  // Same response shape as every other factor, plus how many recovery codes are
  // left when one was just spent — the UI nags at zero.
  sendSuccess(res, 200, {
    ok: true,
    stepUpToken: token,
    expiresAt,
    method: 'totp',
    via: verification.method,
    recoveryCodesRemaining: verification.recoveryCodesRemaining,
  });
}, TOTP_ERROR_MAP);

// -- Sign-in ------------------------------------------------------------------

/**
 * POST /auth/mfa/verify — finish a password sign-in with a second factor.
 *
 * The challenge is READ, not spent, until the code verifies: a mistyped digit
 * must not send the person back to re-enter their password. Guessing is bounded
 * twice — the route's own limiter and the per-user TOTP lockout — and the
 * challenge dies with its 5-minute TTL regardless.
 *
 * Every refusal is the same opaque 401 the password path gives, with the reason
 * only in the audit trail. The ONE exception is SSO enforcement, which answers
 * `403 SSO_REQUIRED` naming the org: by this point the caller has proven the
 * password, so they ARE that user, and the code is what routes the sign-in page
 * into the right IdP. (It is re-checked here because an org can start enforcing
 * SSO between the two legs.)
 */
export const verifyMfaLogin = withController('MFA login verify', async (req, res) => {
  const body = validateBody(mfaVerifySchema, req.body, res);
  if (!body) return;

  const deny = (reason: string, userId?: string): void => {
    audit(req, 'user.login.failed', {
      targetType: 'user',
      ...(userId && { targetId: userId }),
      outcome: 'failure',
      details: { method: 'totp', reason },
    });
    incCounter('platform_logins_failed_total');
    meter('login', reason === TOTP_LOCKED_OUT ? 'locked' : 'failure');
    sendError(res, 401, 'Invalid credentials');
  };

  // Claimed atomically: a concurrent attempt on the same handle finds nothing.
  const pending = await claimMfaChallenge(body.challengeId);
  if (!pending) {
    // The ONE refusal that is not opaque. A challenge handle is 256 unguessable
    // bits, so "this one is gone" is no oracle — and a caller retrying a code
    // against a dead challenge can only fail forever, so the UI needs to know to
    // send them back to the password field rather than keep asking for codes.
    audit(req, 'user.login.failed', {
      targetType: 'user',
      outcome: 'failure',
      details: { method: 'totp', reason: TOTP_INVALID_CHALLENGE },
    });
    incCounter('platform_logins_failed_total');
    meter('login', 'failure');
    return sendError(res, 401, TOTP_ERROR_MAP[TOTP_INVALID_CHALLENGE].message, TOTP_INVALID_CHALLENGE);
  }

  // A RECOVERY-ONLY challenge (a passkey account whose org policy refused the
  // password alone) accepts nothing but one of the account's recovery codes,
  // under their own lockout; otherwise it is the authenticator app's code or a
  // recovery code, under the enrolment's.
  let verification: totp.TotpVerification;
  try {
    verification = pending.recoveryOnly
      ? { method: 'recovery', recoveryCodesRemaining: await verifyRecoveryCode(pending.userId, body.code) }
      : await totp.verifyCode(pending.userId, body.code);
  } catch (err) {
    // A wrong code (or a lockout) hands the handle back for another try.
    await restoreMfaChallenge(body.challengeId, pending);
    return deny(err instanceof Error ? err.message : 'unknown', pending.userId);
  }

  const user = await authService.findForTokenIssue(pending.userId);
  if (!user) return deny('user-missing', pending.userId);
  if (await rejectIfSsoEnforced(res, user.email)) {
    // Not spent by a refusal: the handle goes back (it still can't open a
    // session while the org enforces SSO).
    await restoreMfaChallenge(body.challengeId, pending);
    audit(req, 'user.login.failed', {
      targetType: 'user',
      targetId: pending.userId,
      outcome: 'failure',
      details: { method: 'totp', reason: 'sso-enforced' },
    });
    incCounter('platform_logins_failed_total');
    meter('login', 'failure');
    return;
  }

  // The handle was spent when claimed — it can never yield a second session.

  if (verification.method === 'recovery') auditRecoveryUsed(req, pending.userId, 'login', verification.recoveryCodesRemaining);

  // The password verified in the first leg no longer meets the person's org
  // password policy: both factors are proven, but the sign-in owes a password
  // change before any session opens (services/password-change-challenge.ts).
  // The change leg inherits THIS leg's assurance (`pwd` + `mfa`, aal 2).
  if (pending.passwordChangeMinLength) {
    const { createPasswordChangeChallenge } = await import('../services/password-change-challenge.js');
    const challenge = await createPasswordChangeChallenge({
      userId: pending.userId,
      ...(pending.orgId ? { orgId: pending.orgId } : {}),
      amr: ['pwd', 'mfa'],
      aal: 2,
      minLength: pending.passwordChangeMinLength,
    });
    audit(req, 'user.password.change_required', {
      targetType: 'user',
      targetId: pending.userId,
      details: { minLength: pending.passwordChangeMinLength },
    });
    incCounter('platform_password_change_required_total');
    return sendSuccess(res, 200, {
      passwordChangeRequired: true,
      ...challenge,
      ...(verification.method === 'recovery' && { recoveryCodesRemaining: verification.recoveryCodesRemaining }),
    });
  }

  // Identical to the password path, with `mfa` added to `amr` — and `aal: 2`,
  // since a password plus an authenticator code (or a recovery code, which is
  // the same factor's fallback) is exactly what MFA-grade means.
  const firstFactor = pending.firstFactor ?? 'pwd';
  await completeInteractiveSignIn(req, res, user, {
    orgId: pending.orgId ?? user.lastActiveOrgId?.toString(),
    auth: signInAuth(firstFactor, { mfa: true }),
    auditDetails: { method: `${firstFactor}+${pending.recoveryOnly ? 'recovery' : 'totp'}`, via: verification.method },
    ...(verification.method === 'recovery' && { extra: { recoveryCodesRemaining: verification.recoveryCodesRemaining } }),
  });
  meter('login', verification.method === 'recovery' ? 'recovery' : 'success');
  logger.info('MFA sign-in completed', { userId: pending.userId, via: verification.method });
}, { ...TOTP_ERROR_MAP, ...MFA_POLICY_ERROR_MAP });

/** A recovery code was spent. Its own action, because burning one is a signal an
 *  operator wants to see even when the sign-in itself was legitimate. */
function auditRecoveryUsed(
  req: Parameters<typeof audit>[0],
  userId: string,
  context: 'login' | 'step-up',
  remaining: number,
): void {
  audit(req, 'user.mfa.recovery_used', {
    targetType: 'user',
    targetId: userId,
    details: { context, remaining },
  });
  logger.warn('Recovery code used', { userId, context, remaining });
}
