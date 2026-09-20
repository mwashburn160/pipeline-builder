// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, createSafeClient, getServiceAuthHeader, isSystemOrgId } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { isBootstrapExceptionOpen, isBootstrapSuperAdminEmail, recordBootstrapSession } from '../helpers/bootstrap-admin.js';
import { clientInfoOf } from '../helpers/client-info.js';
import { withController } from '../helpers/controller-helper.js';
import { MFA_POLICY_ERROR_MAP } from '../helpers/mfa-policy.js';
import { clearRefreshCookie, deliverSessionTokens } from '../helpers/session-cookie.js';
import { rejectIfSsoEnforced } from '../helpers/sso-enforcement.js';
import { callerRestriction } from '../helpers/token-permissions.js';
import { incCounter } from '../observability/metrics.js';
import { DUPLICATE_CREDENTIALS, MFA_REQUIRED_FOR_ORG, RESERVED_ORG_NAME, ONBOARDING_USER_NOT_FOUND, ONBOARDING_NO_ORG, SESSION_AUTH_MISSING } from '../services/auth-errors.js';
import { provisionBillingSubscription } from '../services/billing-provision.js';
import { auditService, authService } from '../services/index.js';
import { JOIN_NOT_ELIGIBLE, JOIN_SEAT_LIMIT } from '../services/org-domain-errors.js';
import type { AccessTokenPayload } from '../types/index.js';
import { authFromClaims, issueTokens, renewSessionTokens, signInAuth } from '../utils/token.js';
import { validateBody, registerSchema, loginSchema, completeOnboardingSchema, joinOrgSchema } from '../utils/validation.js';

const logger = createLogger('auth-controller');

/** Auto-subscribe a new org to all published compliance rules (inactive, fire-and-forget). */
async function autoSubscribeToPublishedRules(orgId: string): Promise<void> {
  try {
    const client = createSafeClient({
      host: config.compliance.serviceHost,
      port: config.compliance.servicePort,
      timeout: config.compliance.serviceTimeout,
    });

    const res = await client.post('/compliance/subscriptions/auto-subscribe', {}, {
      headers: {
        'x-org-id': orgId,
        'authorization': getServiceAuthHeader({ serviceName: 'platform', orgId, role: 'member' }),
      },
    });
    // The safe client resolves null / an error status instead of throwing.
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(res ? `Compliance service returned ${res.statusCode}` : 'Compliance service unreachable');
    }

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

  // Org password policy + breached-password check. A registration that is
  // accepting an invitation also answers to the INVITING org's policy (the
  // new account's own org has none yet) — see helpers/password-policy.ts.
  const { assertNewPasswordAcceptable, invitationOrgForRegistration } = await import('../helpers/password-policy.js');
  const invitedOrgId = body.invitationToken
    ? await invitationOrgForRegistration(body.invitationToken, body.email)
    : undefined;
  await assertNewPasswordAcceptable(body.password, { ...(invitedOrgId ? { extraOrgIds: [invitedOrgId] } : {}) });

  const result = await authService.register(body);
  // isSystemOrgId checks BOTH id and name so a system-named org with an
  // ObjectId id (or vice-versa) is still recognised.
  const isSystem = isSystemOrgId(result.organizationId, result.organizationName);

  if (config.billing.enabled) {
    // Fire-and-forget: retries, then persists a durable marker the reconcile pass
    // provisions later, so a paid-plan signup during a billing outage isn't lost.
    void provisionBillingSubscription(result.organizationId, result.planId || 'developer');
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
  [RESERVED_ORG_NAME]: { status: 403, message: 'That organization name is reserved' },
});

/**
 * POST /auth/onboarding/complete
 *
 * Finish first-run onboarding for a social-signup user: name the auto-created
 * personal org and optionally pick a plan, then clear the `needsOnboarding`
 * flag. Plan provisioning is fire-and-forget (mirrors register); the org rename
 * + flag clear happen synchronously in the service.
 */
export const completeOnboarding = withController('Complete onboarding', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Unauthorized');
  const body = validateBody(completeOnboardingSchema, req.body, res);
  if (!body) return;

  const result = await authService.completeOnboarding(req.user.sub, { organizationName: body.organizationName });

  if (config.billing.enabled && body.planId) {
    void provisionBillingSubscription(result.organizationId, body.planId);
  }

  audit(req, 'user.onboarding.complete', { targetType: 'organization', targetId: result.organizationId });
  incCounter('platform_onboarding_complete_total');
  sendSuccess(res, 200, result);
}, {
  [ONBOARDING_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [ONBOARDING_NO_ORG]: { status: 409, message: 'No active organization to onboard' },
  [RESERVED_ORG_NAME]: { status: 403, message: 'That organization name is reserved' },
});

/**
 * GET /auth/onboarding/domain-orgs — orgs the signed-in user could join based on
 * their VERIFIED email domain (P2b discovery). Authenticated + verified-email
 * gated so it can't be used to enumerate tenants; returns only name + join-mode.
 */
export const getDomainOrgs = withController('Discover domain orgs', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Unauthorized');
  // Lazy-import so the domain-join dependency chain (dns, seats, roles) isn't
  // pulled into auth.ts's static graph — mirrors register()'s superadmin-bootstrap import.
  const { User } = await import('../models/index.js');
  const { orgDomainService } = await import('../services/org-domain-service.js');
  const user = await User.findById(req.user.sub).select('email isEmailVerified');
  // Only a provider-verified email may discover — an unverified address is an
  // unproven domain claim and must not surface other tenants.
  if (!user || !user.isEmailVerified) return sendSuccess(res, 200, { orgs: [] });
  const orgs = await orgDomainService.findDiscoverableOrgsByEmail(user.email);
  sendSuccess(res, 200, { orgs });
});

/**
 * POST /auth/onboarding/join — act on a domain-discovered org: auto-join (member)
 * or file a join request, re-validated server-side against the caller's verified
 * email. Never trusts the client's eligibility claim.
 */
export const joinDomainOrg = withController('Join domain org', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Unauthorized');
  const body = validateBody(joinOrgSchema, req.body, res);
  if (!body) return;
  const { User } = await import('../models/index.js');
  const { orgDomainService } = await import('../services/org-domain-service.js');
  const user = await User.findById(req.user.sub).select('email isEmailVerified');
  if (!user || !user.isEmailVerified) return sendError(res, 403, 'A verified email is required to join by domain');

  const result = await orgDomainService.requestOrAutoJoin({ _id: user._id, email: user.email }, body.orgId);
  if (result.status === 'joined') {
    // Distinct from admin approval — this is the user self-joining an auto domain.
    audit(req, 'org.join.auto', { targetType: 'user', targetId: user._id.toString(), affectedOrgId: body.orgId });
  } else if (result.status === 'requested') {
    audit(req, 'org.join.request', { targetType: 'user', targetId: user._id.toString(), affectedOrgId: body.orgId });
  }
  incCounter('platform_domain_join_total', { status: result.status });
  sendSuccess(res, 200, result);
}, {
  [JOIN_NOT_ELIGIBLE]: { status: 403, message: 'You are not eligible to join that organization' },
  [JOIN_SEAT_LIMIT]: { status: 409, message: 'That organization has no seats available' },
});

/**
 * Login user. POST /auth/login
 *
 * TWO OUTCOMES. For most accounts the password opens the session outright. For
 * an account with an authenticator app it returns `{ mfaRequired: true,
 * challengeId }` and nothing else — see the second-factor branch below.
 */
export const login = withController('Login', async (req, res) => {
  const body = validateBody(loginSchema, req.body, res);
  if (!body) return;

  // Early gate: if the identifier is itself an email whose domain is SSO-forced,
  // turn it away before processing the password at all.
  //
  // NEVER for the bootstrap admin (#8): SSO refuses superadmins outright, so a
  // verified, SSO-enforced domain matching their address would close BOTH
  // sign-in paths and leave the install with no way in at all.
  if (body.identifier.includes('@')
    && !isBootstrapSuperAdminEmail(body.identifier)
    && await rejectIfSsoEnforced(res, body.identifier)) return;

  const user = await authService.findByCredentials(body.identifier, body.password);
  if (!user) {
    // Emit a failed-login audit + counter so brute-force / credential-stuffing
    // attempts are visible to security teams + the Platform Overview
    // dashboard. Captures `identifier` (not the password) — same shape
    // as a typical SIEM auth-failure signal.
    audit(req, 'user.login.failed', { targetType: 'user', outcome: 'failure', details: { identifier: body.identifier } });
    incCounter('platform_logins_failed_total');
    return sendError(res, 401, 'Invalid credentials');
  }

  // Post-credential gate: closes the username-login bypass of the email-identifier
  // early gate above — a covered account can't password-login by username either.
  // Same bootstrap-admin carve-out, for the same reason.
  if (!isBootstrapSuperAdminEmail(user.email) && await rejectIfSsoEnforced(res, user.email)) return;

  // SECOND FACTOR. For an account with an authenticator app the password is only
  // half the credential, so this returns a short-lived, single-use challenge
  // instead of a session: no access token, no refresh cookie, no session slot.
  // POST /auth/mfa/verify trades the challenge plus a code (generated or
  // recovery) for the session this would otherwise have opened. The sign-in is
  // NOT audited as `user.login` here — it hasn't happened yet.
  //
  // Lazily imported, like the other heavy branches in this file: the TOTP
  // service reaches the secret-encryption and SSO-enforcement graphs, and the
  // challenge store reads its own config at module load. Neither belongs in the
  // static import graph of a controller most of whose routes never touch them.
  const userId = user._id.toString();

  // ORG PASSWORD POLICY — the one moment the plaintext is in hand. Only a hash
  // is stored, so a minimum an org raised AFTER this password was set can only
  // be checked here; a password below it opens no session until it is changed
  // (see services/password-change-challenge.ts). Checked BEFORE the second
  // factor is asked for and carried through it, so neither leg skips the other.
  const { passwordShortfall } = await import('../helpers/password-policy.js');
  const shortfall = await passwordShortfall(body.password, userId);

  const { hasActiveTotp } = await import('../services/totp-service.js');
  if (await hasActiveTotp(userId)) {
    const { createMfaChallenge } = await import('../services/mfa-challenge.js');
    const challenge = await createMfaChallenge(
      userId,
      user.lastActiveOrgId?.toString(),
      shortfall ? { passwordChangeMinLength: shortfall.minLength } : {},
    );
    incCounter('platform_mfa_challenges_total');
    return sendSuccess(res, 200, {
      mfaRequired: true,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      // What the code may be. Both go to the same endpoint; this is only so the
      // UI can word the field ("code from your app, or a recovery code").
      methods: ['totp', 'recovery'],
    });
  }

  if (shortfall) {
    const { createPasswordChangeChallenge } = await import('../services/password-change-challenge.js');
    const challenge = await createPasswordChangeChallenge({
      userId,
      ...(user.lastActiveOrgId ? { orgId: user.lastActiveOrgId.toString() } : {}),
      amr: ['pwd'],
      aal: 1,
      minLength: shortfall.minLength,
    });
    audit(req, 'user.password.change_required', {
      targetType: 'user',
      targetId: userId,
      ...(shortfall.orgId ? { affectedOrgId: shortfall.orgId } : {}),
      details: { minLength: shortfall.minLength },
    });
    incCounter('platform_password_change_required_total');
    return sendSuccess(res, 200, { passwordChangeRequired: true, ...challenge });
  }

  // BOOTSTRAP-ADMIN EXCEPTION (#8, revision 4). A fresh install has one admin
  // and no factor, so the org policy that would otherwise apply to the system
  // org cannot apply to them yet. They get a limited `aal: 1` session that
  // reaches only enrolment, sign-out and the setup routes; it closes for good at
  // their first enrolment. Resolved AFTER the TOTP branch on purpose — an admin
  // with an authenticator app has already closed it, and must take the normal
  // second-factor path.
  const bootstrapPending = await isBootstrapExceptionOpen(user);

  // Password sign-in opens an INTERACTIVE session (`amr: ['pwd']`).
  let tokens;
  try {
    tokens = await issueTokens(user, user.lastActiveOrgId?.toString(), {
      kind: 'interactive',
      auth: signInAuth('pwd'),
      client: clientInfoOf(req),
      ...(bootstrapPending ? { mfaEnrollmentPending: true } : {}),
    });
  } catch (err) {
    // RECOVERY CODES FOR A PASSKEY ACCOUNT. The org requires MFA, so the
    // password alone was refused — and this account has no authenticator app to
    // ask for. Its passkey is the normal way in; if that is lost, the account's
    // recovery codes are the fallback, so offer a challenge that only a recovery
    // code can finish (`pwd` + recovery code = `aal: 2`, as with TOTP).
    if (err instanceof Error && err.message === MFA_REQUIRED_FOR_ORG) {
      const { hasUnspentRecoveryCodes } = await import('../services/recovery-codes-service.js');
      if (await hasUnspentRecoveryCodes(userId)) {
        const { createMfaChallenge } = await import('../services/mfa-challenge.js');
        const challenge = await createMfaChallenge(userId, user.lastActiveOrgId?.toString(), { recoveryOnly: true });
        incCounter('platform_mfa_challenges_total');
        return sendSuccess(res, 200, {
          mfaRequired: true,
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
          methods: ['recovery'],
        });
      }
    }
    throw err;
  }

  if (bootstrapPending) await recordBootstrapSession(req, user._id.toString(), user.email);

  audit(req, 'user.login', { targetType: 'user', targetId: user._id.toString() });
  // Counter consumed by the Platform Overview dashboard's "logins/min" panel.
  incCounter('platform_logins_total');
  // Browser: the refresh token leaves as an HttpOnly cookie and never appears
  // in this body. CLI/CI: unchanged, both tokens in the body. The enrolment flag
  // rides along so the UI can send the admin straight to enrolment instead of
  // letting them discover the limit one 403 at a time.
  sendSuccess(res, 200, {
    ...deliverSessionTokens(req, res, tokens),
    ...(bootstrapPending ? { mfaEnrollmentPending: true } : {}),
  });
}, { ...MFA_POLICY_ERROR_MAP });

/**
 * Refresh tokens. POST /auth/refresh
 *
 * Rotates the presented token's refresh-session slot atomically. A miss means
 * the token was already rotated away (reuse — presumed stolen) or the session
 * was invalidated meanwhile: that ONE slot is revoked, the user's other devices
 * stay signed in.
 *
 * INTERACTIVE slots only — `isValidRefreshToken` turns a machine session away
 * before this runs, so an operator's CLI refreshing a login can never trip the
 * reuse detection on a stored machine credential. Machine credentials renew
 * through POST /user/generate-token instead.
 *
 * The presented token comes from `isValidRefreshToken` — the browser's cookie
 * or a CLI caller's body — and the rotated one goes back the same way.
 */
export const refresh = withController('Refresh', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Unauthorized');

  const presentedToken = res.locals.presentedRefreshToken as string;
  const sessionId = res.locals.refreshSessionId as string;

  const user = await authService.findForTokenIssue(req.user.sub);
  // Preserve the active org resolved from the session; fall back to lastActiveOrgId.
  const tokens = user && await renewSessionTokens(
    user,
    req.user.organizationId || user.lastActiveOrgId?.toString(),
    { sessionId, presentedToken, kind: 'interactive' },
    { client: clientInfoOf(req) },
  );
  if (!tokens) {
    await authService.revokeRefreshSession(req.user.sub, sessionId);
    // The slot is gone, so the cookie that named it is now a dead credential —
    // drop it rather than leave the browser retrying a token nothing accepts.
    clearRefreshCookie(res);
    logger.warn('Refresh token reuse detected, revoked its session', { userId: req.user.sub, sessionId });
    return sendError(res, 401, 'Session invalidated — please log in again');
  }

  sendSuccess(res, 200, deliverSessionTokens(req, res, tokens));
}, {
  // A session opened before the org turned "require MFA" on stops refreshing
  // once the grace period ends — that IS the enforcement (see `mintTokens`), and
  // the client's answer is to sign in again with a second factor.
  ...MFA_POLICY_ERROR_MAP,
});

/**
 * Logout this device. POST /auth/logout
 *
 * Revokes the refresh-session slot the access token was minted for; the user's
 * other devices stay signed in ("sign out everywhere" is
 * POST /user/tokens/revoke-all). The access token itself stays valid until it
 * expires (short TTL) — the client discards it.
 *
 * The browser's refresh cookie is cleared unconditionally: a script can't do it
 * (HttpOnly), so this response is the only thing that can. Unconditional
 * because a caller with no cookie is simply unaffected.
 */
export const logout = withController('Logout', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, 'Unauthorized');

  const sessionId = (req.user as AccessTokenPayload).sid;
  if (sessionId) await authService.revokeRefreshSession(userId, sessionId);

  clearRefreshCookie(res);
  audit(req, 'user.logout');
  sendSuccess(res, 200, undefined, 'Logged out');
});

/**
 * Switch active organization. POST /auth/switch-org
 *
 * Re-issues the CURRENT session's tokens (same refresh-session slot) scoped to
 * the new org, so switching never consumes another device's slot — and never
 * changes its kind, scope or assurance. A token with no session slot (a PAT)
 * gets a new interactive session carrying the PAT's own scope and assurance.
 */
export const switchOrg = withController('Switch org', async (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, 'Unauthorized');

  const { organizationId } = req.body;
  if (!organizationId) return sendError(res, 400, 'organizationId is required');

  const fromOrgId = req.user?.organizationId;
  // Membership in the org, or admin authority inherited from an ancestor (a
  // parent admin opening one of its teams) — see helpers/org-authority.ts.
  const switched = await authService.switchActiveOrg(userId, organizationId);
  if (!switched) return sendError(res, 403, 'You are not an active member of this organization');
  const { user, authority } = switched;

  const sessionId = (req.user as AccessTokenPayload).sid;
  // A scoped or permission-restricted caller keeps its narrowing across the
  // switch (never widened) — see helpers/token-permissions.ts.
  const tokens = sessionId
    ? await renewSessionTokens(user, organizationId, { sessionId }, { client: clientInfoOf(req) })
    : await issueTokens(user, organizationId, {
      kind: 'interactive',
      auth: authFromClaims(req.user),
      client: clientInfoOf(req),
      ...callerRestriction(req),
    });
  if (!tokens) return sendError(res, 401, 'Session invalid');

  // Record which org the actor pivoted their session INTO. `affectedOrgId` is
  // the destination org so it surfaces in that org's audit view.
  audit(req, 'org.switch', {
    affectedOrgId: organizationId,
    details: {
      fromOrgId,
      toOrgId: organizationId,
      // An inherited-authority switch names the ancestor whose admin membership
      // let the actor in — the team's roster does not show them.
      ...(authority.via === 'ancestor' ? { via: 'ancestor', inheritedFromOrgId: authority.inheritedFromOrgId } : {}),
    },
  });

  // Same slot, new token pair — the browser's cookie is rotated in place.
  sendSuccess(res, 200, deliverSessionTokens(req, res, tokens));
}, {
  // A caller whose token predates the identity claims can't have its assurance
  // inherited — fail closed and make it re-authenticate.
  [SESSION_AUTH_MISSING]: { status: 401, message: 'Session cannot be re-issued — please sign in again' },
  // Switching INTO an org that requires MFA is refused for an aal-1 session; the
  // person stays where they were and enrols first.
  ...MFA_POLICY_ERROR_MAP,
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

  // `isEmailVerified` is the only proof-of-domain-control the domain-based-join
  // flow trusts, so the link path leaves the same trail as the superadmin
  // self-verify (`markEmailVerified`) above. Public route: there is no
  // `req.user`, so `audit(req, ...)` would file it under an anonymous actor —
  // attribute it to the user the TOKEN resolved to, via createEvent. NEVER the
  // token itself. Fire-and-forget: an audit error must not fail the verify.
  const verifiedOrgId = user.lastActiveOrgId != null ? String(user.lastActiveOrgId) : undefined;
  auditService.createEvent({
    action: 'user.email.verified',
    actorId: user._id.toString(),
    actorEmail: user.email,
    orgId: verifiedOrgId,
    affectedOrgId: verifiedOrgId,
    targetType: 'user',
    targetId: user._id.toString(),
    outcome: 'success',
    ip: req.ip,
    details: { via: 'token' },
  }).catch((err) => logger.warn('Failed to write user.email.verified audit event', { error: err instanceof Error ? err.message : String(err) }));

  sendSuccess(res, 200, undefined, 'Email verified successfully');
});

/**
 * POST /auth/mark-email-verified
 *
 * Directly mark the CURRENT user's email verified WITHOUT the emailed link — a
 * convenience for platform operators in environments with no outbound email.
 *
 * SUPERADMIN ONLY. It only ever verifies the caller's OWN email, so an
 * "admin/owner" delegation was never meaningful — and every self-registered user
 * is `owner` of their personal org, which made the old admin/owner gate
 * effectively "any authenticated user can self-assert verification." Since
 * `isEmailVerified` is the sole proof-of-control the domain-based-join flow
 * trusts, that let an attacker register `x@bigcorp.com`, self-verify, and
 * auto-join bigcorp's org. Restricting to superadmin closes that path. Requires
 * auth (route middleware).
 */
export const markEmailVerified = withController('Mark email verified', async (req, res) => {
  if (!req.user) return sendError(res, 401, 'Authentication required');
  if (req.user.isSuperAdmin !== true) {
    return sendError(res, 403, 'Only a superadmin can mark an email verified directly');
  }
  const user = await authService.markEmailVerifiedById(req.user.sub);
  if (!user) return sendError(res, 404, 'User not found');
  audit(req, 'user.email.verified', { targetType: 'user', targetId: req.user.sub });
  sendSuccess(res, 200, undefined, 'Email marked verified');
});
