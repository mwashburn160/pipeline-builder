// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared tail of every interactive sign-in (password, social, passkey,
 * OIDC/SAML SSO, the MFA challenge, the forced password change): mint the
 * session, record it, answer with the transport the caller uses. One place, so
 * the audit shape, the counters and the cookie/body split cannot drift between
 * sign-in methods.
 */

import { sendSuccess } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { audit } from './audit.js';
import { clientInfoOf } from './client-info.js';
import { clearLoginBinding } from './login-binding.js';
import { idpEnforcesMfa } from './mfa-policy.js';
import { deliverSessionTokens } from './session-cookie.js';
import type { UserDocument } from '../models/user.js';
import { incCounter } from '../observability/metrics.js';
import { signInAuth, type SessionAuth } from '../services/session/access-tokens.js';
import { issueTokens, type IssuedTokens } from '../services/session/refresh-sessions.js';

export interface CompleteSignInOptions {
  /** The org to open the session in; `issueTokens` falls back to the user's own membership. */
  orgId: string | undefined;
  /** How the person proved themselves (see `signInAuth`). */
  auth: SessionAuth;
  /** `details` of the `user.login` audit event. */
  auditDetails?: Record<string, unknown>;
  /** `affectedOrgId` of the `user.login` audit event (the SSO org). */
  affectedOrgId?: string;
  /** Open the limited bootstrap-administrator enrolment session. */
  bootstrapPending?: boolean;
  /** The flow was browser-bound (OAuth/SSO): drop the binding cookie now it has done its job. */
  clearBinding?: boolean;
  /** Runs once the tokens exist, before anything is recorded (e.g. SAML's session index). */
  afterIssue?: (tokens: IssuedTokens) => Promise<void>;
  /** Extra response fields. */
  extra?: Record<string, unknown>;
}

/**
 * Open an INTERACTIVE session for `user`, audit it as `user.login`, count it,
 * and answer 200 — the refresh token as an HttpOnly cookie for the browser, in
 * the body for everyone else. Errors from token issuance (e.g. the org's MFA
 * requirement) propagate before anything is recorded or sent.
 */
export async function completeInteractiveSignIn(
  req: Request,
  res: Response,
  user: UserDocument,
  opts: CompleteSignInOptions,
): Promise<void> {
  const userId = user._id.toString();
  const tokens = await issueTokens(user, opts.orgId, {
    kind: 'interactive',
    auth: opts.auth,
    client: clientInfoOf(req),
    ...(opts.bootstrapPending ? { mfaEnrollmentPending: true } : {}),
  });
  if (opts.afterIssue) await opts.afterIssue(tokens);

  if (opts.bootstrapPending) {
    // Lazily imported: only the rare bootstrap sign-in needs the audit trail of
    // the exception, and its module reaches the install-time records.
    const { recordBootstrapSession } = await import('./bootstrap-admin.js');
    await recordBootstrapSession(req, userId, user.email);
  }

  audit(req, 'user.login', {
    targetType: 'user',
    targetId: userId,
    ...(opts.affectedOrgId ? { affectedOrgId: opts.affectedOrgId } : {}),
    ...(opts.auditDetails ? { details: opts.auditDetails } : {}),
  });
  // Feeds the Platform Overview dashboard's "logins/min" panel.
  incCounter('platform_logins_total');

  if (opts.clearBinding) clearLoginBinding(res);
  sendSuccess(res, 200, {
    ...deliverSessionTokens(req, res, tokens),
    // Lets the UI send the bootstrap admin straight to enrolment instead of
    // letting them discover the limit one 403 at a time.
    ...(opts.bootstrapPending ? { mfaEnrollmentPending: true } : {}),
    ...opts.extra,
  });
}

/**
 * The assurance an SSO sign-in (OIDC or SAML) earns in `orgId`: `aal: 2` only
 * when the org has marked its own IdP as enforcing MFA. Providers don't send
 * `amr` reliably, so the org's statement about the IdP it administers is the
 * evidence; an unmarked IdP stays `aal: 1` rather than being guessed at.
 */
export async function ssoAuth(orgId: string): Promise<SessionAuth> {
  return signInAuth('sso', { ...(await idpEnforcesMfa(orgId) ? { idpMfaOrgId: orgId } : {}) });
}

/**
 * Answer a first-factor sign-in with a second-factor CHALLENGE instead of a
 * session: a short-lived, single-use handle `POST /auth/mfa/verify` trades,
 * with a code, for the session. No token, cookie or session slot is created.
 */
export async function sendMfaChallenge(
  res: Response,
  userId: string,
  orgId: string | undefined,
  opts: { recoveryOnly?: boolean; passwordChangeMinLength?: number; firstFactor?: 'pwd' | 'oauth' } = {},
): Promise<void> {
  // Lazily imported: the challenge store reads its own config at module load,
  // which most routes of the importing controllers never need.
  const { createMfaChallenge } = await import('../services/mfa-challenge.js');
  const challenge = await createMfaChallenge(userId, orgId, opts);
  incCounter('platform_mfa_challenges_total');
  sendSuccess(res, 200, {
    mfaRequired: true,
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    // What the code may be. Both go to the same endpoint; this is only so the
    // UI can word the field ("code from your app, or a recovery code").
    methods: opts.recoveryOnly ? ['recovery'] : ['totp', 'recovery'],
  });
}

/**
 * Open the second-factor challenge when the account has an authenticator app
 * (a password or social sign-in is only half of such an account's
 * credential). Returns true when the challenge was sent.
 */
export async function openMfaChallengeIfOwed(
  res: Response,
  userId: string,
  orgId: string | undefined,
  opts: { passwordChangeMinLength?: number; firstFactor?: 'pwd' | 'oauth' } = {},
): Promise<boolean> {
  const { hasActiveTotp } = await import('./auth-factors.js');
  if (!(await hasActiveTotp(userId))) return false;
  await sendMfaChallenge(res, userId, orgId, opts);
  return true;
}
