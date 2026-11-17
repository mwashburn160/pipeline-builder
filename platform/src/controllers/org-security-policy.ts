// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's password policy, authenticator (passkey model) policy and
 * session-lifetime policy — read and update.
 *
 *   GET   /organization/:id/password-policy
 *   PATCH /organization/:id/password-policy
 *   GET   /organization/:id/authenticator-policy
 *   PATCH /organization/:id/authenticator-policy
 *   GET   /organization/:id/session-policy
 *   PATCH /organization/:id/session-policy
 *
 * Gated on `org_settings:write` (+ step-up for the writes) at the route and on
 * `canManageOrgScope` here — the same tenancy rule as the MFA policy, so an
 * admin of a parent org may set them for a team beneath it. LOOSENING any
 * (a lower minimum, clearing or widening the allowlist, lengthening sessions)
 * additionally needs an
 * `aal: 2` session, exactly as loosening the MFA policy does; tightening stays
 * open to a single-factor admin.
 *
 * Enforcement lives elsewhere: `helpers/password-policy.ts` (every
 * password-setting path, and password sign-in) and
 * `helpers/authenticator-policy.ts` + `services/webauthn-service.ts`
 * (registration) + `utils/token.ts` (issuance); `helpers/session-policy.ts` +
 * `services/session/refresh-sessions.ts` (every refresh and switch-org).
 */

import { createLogger, getParam, refuseWeakSession, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { normalizeAaguid } from '../helpers/authenticator-policy.js';
import { canManageOrgScope, ensureAuthenticated, forbid, withController } from '../helpers/controller-helper.js';
import { resolveEffectiveMfaPolicy } from '../helpers/mfa-policy.js';
import { incCounter } from '../observability/metrics.js';
import {
  authenticatorPolicyView,
  callerKeepsAFactor,
  effectiveAllowlistWith,
  isLooseningSessionPolicy,
  nextSessionPolicy,
  orgExists,
  passwordPolicyView,
  readOwnAaguids,
  readOwnPasswordMinLength,
  readOwnSessionPolicy,
  sessionPolicyView,
  writeAaguids,
  writePasswordMinLength,
  writeSessionPolicy,
} from '../services/org-policy-service.js';
import { updateAuthenticatorPolicySchema, updatePasswordPolicySchema, updateSessionPolicySchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-security-policy');

/** Shared front half: authenticated, administers the org, org exists. */
async function administeredOrgId(
  req: Parameters<Parameters<typeof withController>[1]>[0],
  res: Parameters<Parameters<typeof withController>[1]>[1],
  verb: 'view' | 'change',
): Promise<string | null> {
  if (!ensureAuthenticated(req, res)) return null;
  const id = getParam(req.params, 'id')!;
  if (!(await canManageOrgScope(req, id))) {
    forbid(req, res, 'org-admin', `You can only ${verb} the policy of an organization you administer`);
    return null;
  }
  if (!(await orgExists(id))) {
    sendError(res, 404, 'Organization not found');
    return null;
  }
  return id;
}

// -- Password policy ------------------------------------------------------------

export const getPasswordPolicy = withController('Get password policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'view');
  if (!id) return;
  sendSuccess(res, 200, await passwordPolicyView(id));
});

export const updatePasswordPolicy = withController('Update password policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'change');
  if (!id) return;
  const body = validateBody(updatePasswordPolicySchema, req.body, res);
  if (!body) return;

  const from = await readOwnPasswordMinLength(id);
  const to = body.minLength;
  // Lowering (or clearing) the minimum weakens the org's protection.
  const loosening = from !== null && (to === null || to < from);
  if (loosening && refuseWeakSession(req, res, { minAssurance: 2 })) return;

  await writePasswordMinLength(id, to);

  audit(req, 'org.password_policy.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { minLength: { from, to } },
  });
  incCounter('platform_password_policy_changes_total');
  logger.info('Password policy updated', { orgId: id, by: req.user!.sub, from, to });
  sendSuccess(res, 200, await passwordPolicyView(id), 'Password policy updated');
});

// -- Authenticator (AAGUID) policy ---------------------------------------------

export const getAuthenticatorPolicy = withController('Get authenticator policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'view');
  if (!id) return;
  sendSuccess(res, 200, await authenticatorPolicyView(id));
});

export const updateAuthenticatorPolicy = withController('Update authenticator policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'change');
  if (!id) return;
  const body = validateBody(updateAuthenticatorPolicySchema, req.body, res);
  if (!body) return;

  const invalid = body.allowedAaguids.filter((v) => normalizeAaguid(v) === null);
  if (invalid.length > 0) {
    return sendError(res, 400, `Not a valid authenticator AAGUID: ${invalid.join(', ')}`, 'INVALID_AAGUID', { invalid });
  }
  const next = [...new Set(body.allowedAaguids.map((v) => normalizeAaguid(v)!))];

  const prev = await readOwnAaguids(id);
  // Clearing the list, or adding a model to an existing one, WIDENS what counts
  // as a trusted passkey — a weakening, like lowering the password minimum.
  const loosening = prev.length > 0 && (next.length === 0 || next.some((v) => !prev.includes(v)));
  if (loosening && refuseWeakSession(req, res, { minAssurance: 2 })) return;

  // REFUSE THE LOCKOUT. Where the org enforces MFA, an admin whose only factor
  // is a passkey the NEW list rejects would drop to `aal: 1` here — and be
  // refused at their next sign-in, unable to fix the list. They add their own
  // model (or an authenticator app) first.
  if (next.length > 0) {
    const effectiveNext = await effectiveAllowlistWith(id, next);
    const mfa = await resolveEffectiveMfaPolicy(id);
    if (mfa.enforced && !(await callerKeepsAFactor(req.user!.sub, effectiveNext))) {
      return sendError(
        res, 409,
        'This list would leave you without an accepted second factor in an organization that requires MFA. '
          + 'Add the model of one of your own passkeys, or enrol an authenticator app, first.',
        'AUTHENTICATOR_POLICY_LOCKOUT',
      );
    }
  }

  await writeAaguids(id, next);

  audit(req, 'org.authenticator_policy.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      added: next.filter((v) => !prev.includes(v)),
      removed: prev.filter((v) => !next.includes(v)),
      count: { from: prev.length, to: next.length },
    },
  });
  incCounter('platform_authenticator_policy_changes_total');
  logger.info('Authenticator policy updated', { orgId: id, by: req.user!.sub, from: prev.length, to: next.length });
  sendSuccess(res, 200, await authenticatorPolicyView(id), 'Authenticator policy updated');
});

// -- Session-lifetime policy ------------------------------------------------------

export const getSessionPolicy = withController('Get session policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'view');
  if (!id) return;
  sendSuccess(res, 200, await sessionPolicyView(id));
});

export const updateSessionPolicy = withController('Update session policy', async (req, res) => {
  const id = await administeredOrgId(req, res, 'change');
  if (!id) return;
  const body = validateBody(updateSessionPolicySchema, req.body, res);
  if (!body) return;

  const from = await readOwnSessionPolicy(id);
  const to = nextSessionPolicy(from, body);
  // Lengthening sessions (a bound raised or cleared) weakens the org's
  // protection — the same `aal: 2` bar as lowering the password minimum.
  if (isLooseningSessionPolicy(from, to) && refuseWeakSession(req, res, { minAssurance: 2 })) return;

  await writeSessionPolicy(id, to);

  audit(req, 'org.session_policy.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      maxAgeDays: { from: from.maxAgeDays ?? null, to: to.maxAgeDays ?? null },
      idleTimeoutDays: { from: from.idleTimeoutDays ?? null, to: to.idleTimeoutDays ?? null },
    },
  });
  incCounter('platform_session_policy_changes_total');
  logger.info('Session policy updated', { orgId: id, by: req.user!.sub, from, to });
  sendSuccess(res, 200, await sessionPolicyView(id), 'Session policy updated');
});
