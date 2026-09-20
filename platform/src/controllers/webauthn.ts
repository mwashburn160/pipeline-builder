// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkeys (WebAuthn) — the HTTP surface. All ceremony logic lives in
 * `services/webauthn-service.ts`; this file validates, audits, meters and maps
 * errors.
 *
 *   POST   /auth/webauthn/register/options   (step-up gated)
 *   POST   /auth/webauthn/register/verify
 *   GET    /auth/webauthn/credentials
 *   PATCH  /auth/webauthn/credentials/:id
 *   DELETE /auth/webauthn/credentials/:id    (step-up gated)
 *   POST   /auth/webauthn/login/options      (public)
 *   POST   /auth/webauthn/login/verify       (public)
 *   POST   /auth/step-up/webauthn/options
 *   POST   /auth/step-up/webauthn/verify
 *
 * Enrolment and removal need a STEP-UP token, which is factor-agnostic: an
 * account with a password re-enters it, and an account without one (Google /
 * GitHub / SSO sign-up) earns the same token by re-authenticating with its own
 * provider — which is how a first passkey gets registered. Both paths are
 * already what `StepUpModal` offers.
 *
 * Passkey SIGN-IN follows the password path exactly: the SSO-enforcement gate
 * applies, the same `issueTokens` opens the session (so the refresh cookie,
 * session slot and claims are identical), and every failure returns the same
 * opaque 401.
 */

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { z } from 'zod';
import { audit } from '../helpers/audit.js';
import { closeBootstrapExceptionOnEnrolment } from '../helpers/bootstrap-admin.js';
import { clientInfoOf } from '../helpers/client-info.js';
import { withController, type ErrorMap } from '../helpers/controller-helper.js';
import { MFA_POLICY_ERROR_MAP } from '../helpers/mfa-policy.js';
import { deliverSessionTokens } from '../helpers/session-cookie.js';
import { rejectIfSsoEnforced } from '../helpers/sso-enforcement.js';
import { User } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import { authService } from '../services/index.js';
import { clearResetGraceOnEnrolment } from '../services/mfa-enrolment.js';
import { issueRecoveryCodesIfAbsent, removeRecoveryCodesIfNoFactor } from '../services/recovery-codes-service.js';
import {
  WEBAUTHN_ATTESTATION_UNVERIFIABLE,
  WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED,
  WEBAUTHN_COUNTER_REGRESSION,
  WEBAUTHN_CREDENTIAL_EXISTS,
  WEBAUTHN_CREDENTIAL_NOT_FOUND,
  WEBAUTHN_INVALID_CEREMONY,
  WEBAUTHN_LAST_SIGN_IN_METHOD,
  WEBAUTHN_NO_CREDENTIALS,
  WEBAUTHN_VERIFICATION_FAILED,
} from '../services/webauthn-errors.js';
import * as webauthn from '../services/webauthn-service.js';
import { issueStepUpToken, issueTokens, signInAuth } from '../utils/token.js';
import { validateBody } from '../utils/validation.js';

const logger = createLogger('webauthn');

export const WEBAUTHN_ERROR_MAP: ErrorMap = {
  [WEBAUTHN_INVALID_CEREMONY]: { status: 403, message: 'This passkey request expired or was already used. Please try again.' },
  [WEBAUTHN_VERIFICATION_FAILED]: { status: 400, message: 'That passkey could not be verified' },
  [WEBAUTHN_CREDENTIAL_EXISTS]: { status: 409, message: 'This passkey is already registered' },
  [WEBAUTHN_CREDENTIAL_NOT_FOUND]: { status: 404, message: 'Passkey not found' },
  [WEBAUTHN_NO_CREDENTIALS]: { status: 409, message: 'This account has no passkeys' },
  [WEBAUTHN_LAST_SIGN_IN_METHOD]: {
    status: 409,
    message: 'This is the only way you can sign in. Set a password or add another passkey first.',
  },
  [WEBAUTHN_COUNTER_REGRESSION]: { status: 403, message: 'That passkey could not be verified' },
  [WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED]: {
    status: 403,
    message: 'Your organization does not allow this kind of passkey. Use one of the security keys or authenticators it has approved.',
    code: WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED,
  },
  [WEBAUTHN_ATTESTATION_UNVERIFIABLE]: {
    status: 403,
    message: 'Your organization only accepts approved authenticators, and this one could not prove its make and model. Use an approved security key or authenticator.',
    code: WEBAUTHN_ATTESTATION_UNVERIFIABLE,
  },
};

/**
 * The authenticator's reply, forwarded verbatim from `@simplewebauthn/browser`.
 * Validated only for SHAPE — the library re-parses and cryptographically
 * verifies every field, so re-describing the WebAuthn schema here would be a
 * second source of truth that could only drift.
 */
const ceremonyResponseSchema = z.object({
  ceremonyId: z.string().min(1).max(256),
  response: z.object({ id: z.string().min(1).max(512) }).passthrough(),
});

const registerVerifySchema = ceremonyResponseSchema.extend({
  name: z.string().trim().min(1).max(64),
});

const renameSchema = z.object({ name: z.string().trim().min(1).max(64) });

/** Metric for every ceremony outcome, so enrolment and sign-in failures are
 *  visible without reading the audit log. */
function meter(type: 'register' | 'login' | 'stepup', outcome: 'success' | 'failure'): void {
  incCounter('platform_webauthn_ceremonies_total', { type, outcome });
}

/**
 * Audit a refused assertion. A counter regression is its own action (a clone
 * signal an operator should see); everything else is an ordinary failed
 * verification recorded on the sign-in/step-up trail.
 */
function auditAssertionFailure(
  req: Parameters<typeof audit>[0],
  err: unknown,
  ctx: { userId?: string; targetType: 'step-up' | 'user'; credentialId?: string },
): void {
  const reason = err instanceof Error ? err.message : 'unknown';
  if (reason === WEBAUTHN_COUNTER_REGRESSION) {
    audit(req, 'user.passkey.clone_suspected', {
      targetType: 'user',
      ...(ctx.userId && { targetId: ctx.userId }),
      outcome: 'failure',
      details: { ...(ctx.credentialId && { credentialId: ctx.credentialId }) },
    });
    logger.warn('Passkey counter regression — possible cloned credential', {
      userId: ctx.userId, credentialId: ctx.credentialId,
    });
    return;
  }
  audit(req, 'user.login.failed', {
    targetType: ctx.targetType,
    ...(ctx.userId && { targetId: ctx.userId }),
    outcome: 'failure',
    details: { method: 'webauthn', reason },
  });
}

// -- Registration -------------------------------------------------------------

/** POST /auth/webauthn/register/options — begin enrolling a passkey. */
export const registerOptions = withController('Passkey register options', async (req, res) => {
  const userId = req.user!.sub;
  const user = await User.findById(userId).select('email username');
  if (!user) return sendError(res, 401, 'Authentication required');

  const { ceremonyId, options } = await webauthn.registrationOptions({
    userId,
    email: user.email,
    username: user.username,
    // The ACTIVE org's authenticator policy governs the enrolment (direct
    // attestation + MDS check when it allowlists models).
    ...(req.user!.organizationId ? { orgId: req.user!.organizationId } : {}),
  });
  sendSuccess(res, 200, { ceremonyId, options });
}, WEBAUTHN_ERROR_MAP);

/** POST /auth/webauthn/register/verify — store the new passkey. */
export const registerVerify = withController('Passkey register verify', async (req, res) => {
  const userId = req.user!.sub;
  const body = validateBody(registerVerifySchema, req.body, res);
  if (!body) return;

  let passkey;
  try {
    passkey = await webauthn.verifyRegistration(
      userId,
      body.ceremonyId,
      body.response as unknown as Parameters<typeof webauthn.verifyRegistration>[2],
      body.name,
    );
  } catch (err) {
    meter('register', 'failure');
    const reason = err instanceof Error ? err.message : 'unknown';
    // A policy refusal is an ORG-policy event an admin will want to find
    // ("why can't Sam enrol?"), so it is audited, not just metered.
    if (reason === WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED || reason === WEBAUTHN_ATTESTATION_UNVERIFIABLE) {
      audit(req, 'user.passkey.register', {
        targetType: 'user',
        targetId: userId,
        outcome: 'failure',
        ...(req.user!.organizationId ? { affectedOrgId: req.user!.organizationId } : {}),
        details: { reason },
      });
      incCounter('platform_authenticator_policy_refusals_total', { reason });
    }
    throw err;
  }

  audit(req, 'user.passkey.register', {
    targetType: 'user',
    targetId: userId,
    details: {
      passkeyId: passkey.id,
      name: passkey.name,
      backedUp: passkey.backedUp,
      ...(passkey.aaguid ? { aaguid: passkey.aaguid } : {}),
      attestationVerified: passkey.attestationVerified,
    },
  });
  // A factor now exists, so the bootstrap-admin MFA exception (#8) closes — for
  // good, even if this passkey is later removed.
  await closeBootstrapExceptionOnEnrolment(req, userId);
  // ...and so does any MFA-reset enrolment grace: they have enrolled.
  await clearResetGraceOnEnrolment(userId);
  // The account's recovery codes are minted with its FIRST second factor,
  // whichever kind that is. Shown once; a later passkey keeps the same set.
  const recoveryCodes = await issueRecoveryCodesIfAbsent(userId);
  meter('register', 'success');
  sendSuccess(res, 201, { passkey, ...(recoveryCodes ? { recoveryCodes } : {}) });
}, WEBAUTHN_ERROR_MAP);

// -- Management ---------------------------------------------------------------

/** GET /auth/webauthn/credentials — the caller's own passkeys. */
export const listPasskeys = withController('List passkeys', async (req, res) => {
  sendSuccess(res, 200, { passkeys: await webauthn.listCredentials(req.user!.sub) });
}, WEBAUTHN_ERROR_MAP);

/** PATCH /auth/webauthn/credentials/:id — relabel one. */
export const renamePasskey = withController('Rename passkey', async (req, res) => {
  const userId = req.user!.sub;
  const body = validateBody(renameSchema, req.body, res);
  if (!body) return;

  const passkey = await webauthn.renameCredential(userId, String(req.params.id), body.name);
  audit(req, 'user.passkey.rename', {
    targetType: 'user',
    targetId: userId,
    details: { passkeyId: passkey.id, name: passkey.name },
  });
  sendSuccess(res, 200, { passkey });
}, WEBAUTHN_ERROR_MAP);

/** DELETE /auth/webauthn/credentials/:id — revoke one (step-up gated). */
export const removePasskey = withController('Remove passkey', async (req, res) => {
  const userId = req.user!.sub;
  const passkey = await webauthn.removeCredential(userId, String(req.params.id));
  // The last factor took the recovery codes with it: nothing left to recover.
  const recoveryCodesRemoved = await removeRecoveryCodesIfNoFactor(userId);
  audit(req, 'user.passkey.remove', {
    targetType: 'user',
    targetId: userId,
    details: { passkeyId: passkey.id, name: passkey.name, ...(recoveryCodesRemoved ? { recoveryCodesRemoved: true } : {}) },
  });
  sendSuccess(res, 200, { removed: true, passkey });
}, WEBAUTHN_ERROR_MAP);

// -- Step-up ------------------------------------------------------------------

/** POST /auth/step-up/webauthn/options — begin a passkey step-up. */
export const stepUpOptions = withController('Passkey step-up options', async (req, res) => {
  const { ceremonyId, options } = await webauthn.stepUpOptions(req.user!.sub);
  sendSuccess(res, 200, { ceremonyId, options });
}, WEBAUTHN_ERROR_MAP);

/** POST /auth/step-up/webauthn/verify — issue the standard step-up token. */
export const stepUpVerifyWebAuthn = withController('Passkey step-up verify', async (req, res) => {
  const userId = req.user!.sub;
  const body = validateBody(ceremonyResponseSchema, req.body, res);
  if (!body) return;

  let assertion;
  try {
    assertion = await webauthn.verifyStepUp(
      userId,
      body.ceremonyId,
      body.response as unknown as Parameters<typeof webauthn.verifyStepUp>[2],
    );
  } catch (err) {
    auditAssertionFailure(req, err, { userId, targetType: 'step-up', credentialId: body.response.id });
    incCounter('platform_step_up_total', { method: 'webauthn', outcome: 'failure' });
    meter('stepup', 'failure');
    throw err;
  }

  const { token, expiresAt } = await issueStepUpToken(userId, 'webauthn');
  audit(req, 'user.step-up', {
    targetType: 'user',
    targetId: userId,
    details: { method: 'webauthn', passkeyId: assertion.id, name: assertion.name },
  });
  incCounter('platform_step_up_total', { method: 'webauthn', outcome: 'success' });
  meter('stepup', 'success');
  // Same response shape as every other factor.
  sendSuccess(res, 200, { ok: true, stepUpToken: token, expiresAt, method: 'webauthn' });
}, WEBAUTHN_ERROR_MAP);

// -- Sign-in ------------------------------------------------------------------

/**
 * POST /auth/webauthn/login/options — a challenge for a discoverable credential.
 *
 * PUBLIC and deliberately uninformative: it names no user and reveals nothing
 * about which accounts exist, because the browser's autofill UI requests one on
 * every sign-in page load before anyone has typed anything.
 */
export const loginOptions = withController('Passkey login options', async (_req, res) => {
  const { ceremonyId, options } = await webauthn.loginOptions();
  sendSuccess(res, 200, { ceremonyId, options });
}, WEBAUTHN_ERROR_MAP);

/**
 * POST /auth/webauthn/login/verify — sign in with a passkey.
 *
 * Every refusal is the SAME opaque 401 the password path gives, with the reason
 * only in the audit trail: the caller must not learn whether a credential is
 * unknown or simply failed verification.
 *
 * The ONE exception is the SSO-enforcement refusal, which answers `403
 * SSO_REQUIRED` naming the org — exactly as password login does. By that point
 * the caller has produced a verified assertion for the account, so they ARE that
 * user, and the code is what routes the sign-in page into the right IdP.
 */
export const loginVerify = withController('Passkey login verify', async (req, res) => {
  const body = validateBody(ceremonyResponseSchema, req.body, res);
  if (!body) return;

  const deny = (reason: string, userId?: string): void => {
    audit(req, 'user.login.failed', {
      targetType: 'user',
      ...(userId && { targetId: userId }),
      outcome: 'failure',
      details: { method: 'webauthn', reason },
    });
    incCounter('platform_logins_failed_total');
    meter('login', 'failure');
    sendError(res, 401, 'Invalid credentials');
  };

  let assertion;
  try {
    assertion = await webauthn.verifyLogin(
      body.ceremonyId,
      body.response as unknown as Parameters<typeof webauthn.verifyLogin>[1],
    );
  } catch (err) {
    if (err instanceof Error && err.message === WEBAUTHN_COUNTER_REGRESSION) {
      auditAssertionFailure(req, err, { targetType: 'user', credentialId: body.response.id });
      incCounter('platform_logins_failed_total');
      meter('login', 'failure');
      return sendError(res, 401, 'Invalid credentials');
    }
    return deny(err instanceof Error ? err.message : 'unknown');
  }

  const user = await authService.findForTokenIssue(assertion.userId);
  if (!user) return deny('user-missing', assertion.userId);
  // Same rule as password and social sign-in: a domain whose org enforces SSO
  // can't be entered any other way. (Passkey STEP-UP is still allowed — the
  // person is already inside a session SSO admitted.)
  if (await rejectIfSsoEnforced(res, user.email)) {
    audit(req, 'user.login.failed', {
      targetType: 'user',
      targetId: assertion.userId,
      outcome: 'failure',
      details: { method: 'webauthn', reason: 'sso-enforced' },
    });
    incCounter('platform_logins_failed_total');
    meter('login', 'failure');
    return;
  }

  // Identical to the password path: an INTERACTIVE session, `amr: ['webauthn']`
  // — and `aal: 2` (#8). A passkey is verified with user verification REQUIRED
  // (see the WebAuthn service), so a single ceremony proves both the credential
  // and the person, which is what MFA-grade asks for.
  // The passkey's MODEL rides on the session so the active org's authenticator
  // allowlist is applied at issuance (and again at every refresh / switch-org):
  // a model the org does not allowlist still signs the person in, but counts as
  // `aal: 1` there — see helpers/authenticator-policy.ts.
  const tokens = await issueTokens(user, user.lastActiveOrgId?.toString(), {
    kind: 'interactive',
    auth: { ...signInAuth('webauthn'), ...(assertion.aaguid ? { aaguid: assertion.aaguid } : {}) },
    client: clientInfoOf(req),
  });

  audit(req, 'user.login', {
    targetType: 'user',
    targetId: assertion.userId,
    details: { method: 'webauthn', passkeyId: assertion.id },
  });
  incCounter('platform_logins_total');
  meter('login', 'success');
  sendSuccess(res, 200, deliverSessionTokens(req, res, tokens));
}, { ...WEBAUTHN_ERROR_MAP, ...MFA_POLICY_ERROR_MAP });
