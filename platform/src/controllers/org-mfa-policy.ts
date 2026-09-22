// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's "require MFA" policy — read and update.
 *
 *   GET   /organization/:id/mfa-policy
 *   PATCH /organization/:id/mfa-policy
 *
 * The policy is enforced where a token is ISSUED, never per route: a session
 * scoped to this org is minted at `aal: 2` or refused (see `utils/token.ts`).
 * These two endpoints are only how the setting is read and written.
 *
 * Both are gated on `org:settings` plus step-up at the route, and on
 * `canManageOrgScope` here — the same tenancy rule the impersonation policy uses,
 * so an admin of a parent org may set the policy for a team beneath it.
 *
 * ASSURANCE IS DIRECTIONAL. Any change that WEAKENS the org's protection —
 * turning "require MFA" off, turning "administrative actions require MFA" off,
 * or stating that the org's IdP enforces MFA (which makes SSO sessions count as
 * `aal: 2` on the org's word) — needs an `aal: 2` session. TIGHTENING stays open
 * to a single-factor session, so an admin who has no factor yet can still adopt
 * MFA for the org. The route table can't express "sometimes", so the check is
 * here (`refuseWeakSession`), with the same refusals as `requireAssurance`.
 *
 * The same route also carries `adminActionsRequireMfa`. TURNING IT ON bumps every
 * affected member's session (see `services/admin-mfa-claims.ts`) so a
 * single-factor session can't keep acting as an admin on a stale claim. Turning
 * it OFF does not: a stale token then carries the STRICTER claim, which lapses at
 * its next refresh (every issuance path re-resolves the policy) — the same
 * one-access-token-lifetime settling `requireMfa` relies on, without signing the
 * whole org out to relax a control.
 */

import { createLogger, getParam, refuseWeakSession, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { canManageOrgScope, ensureAuthenticated, withController } from '../helpers/controller-helper.js';
import { resolveEffectiveMfaPolicy } from '../helpers/mfa-policy.js';
import { incCounter } from '../observability/metrics.js';
import { refreshAdminPolicyClaims } from '../services/admin-mfa-claims.js';
import { MFA_BOOTSTRAP_STILL_OPEN } from '../services/auth-errors.js';
import { anyOpenBootstrapException, isLooseningMfa, mfaEnrolment, mfaPolicyView, orgExists, readMfaPolicyState, writeMfaPolicy } from '../services/org-policy-service.js';
import { updateMfaPolicySchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-mfa-policy');

export const getMfaPolicy = withController('Get MFA policy', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canManageOrgScope(req, id))) {
    return sendError(res, 403, 'You can only view the policy of an organization you administer');
  }
  if (!(await orgExists(id))) return sendError(res, 404, 'Organization not found');

  // Both the org's OWN setting and what actually governs: a team's policy can be
  // tightened by a parent, so returning only `own` would let an admin set it off
  // and never learn why members are still being asked for a second factor. The
  // enrolment counts ride along so the grace-period decision has a number.
  const [policy, counts] = await Promise.all([resolveEffectiveMfaPolicy(id), mfaEnrolment(id)]);
  sendSuccess(res, 200, { ...(await mfaPolicyView(policy)), enrolment: counts });
});

export const updateMfaPolicy = withController('Update MFA policy', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canManageOrgScope(req, id))) {
    return sendError(res, 403, 'You can only change the policy of an organization you administer');
  }

  const body = validateBody(updateMfaPolicySchema, req.body, res);
  if (!body) return;

  const before = await readMfaPolicyState(id);
  if (!before) return sendError(res, 404, 'Organization not found');

  const turningOn = body.requireMfa === true && before.requireMfa !== true;

  // Weakening needs a session opened with a second factor (see the module doc).
  if (isLooseningMfa(before, body) && refuseWeakSession(req, res, { minAssurance: 2 })) return;

  // REFUSE THE LOCKOUT. While the bootstrap-admin exception is still open, the
  // install's only admin has no factor — turning the requirement on for the
  // SYSTEM org would refuse their next sign-in and leave nobody able to close
  // the exception. They enrol first; then this is allowed.
  if (turningOn && before.isSystem === true && await anyOpenBootstrapException()) {
    throw new Error(MFA_BOOTSTRAP_STILL_OPEN);
  }

  const effective = await writeMfaPolicy(id, body, turningOn);

  // The admin-actions policy rides a token claim. Tightening must reach the
  // sessions already issued (this org and every team beneath it) at once;
  // loosening can wait for each token's next refresh — a stale token is only
  // stricter than the policy, never weaker.
  const adminActionsChanged = body.adminActionsRequireMfa !== undefined
    && body.adminActionsRequireMfa !== (before.adminActionsRequireMfa === true);
  const adminActionsTightened = adminActionsChanged && body.adminActionsRequireMfa === true;
  const sessionsRefreshed = adminActionsTightened ? await refreshAdminPolicyClaims(id, req.user!.sub) : 0;

  // Both sides of the transition: tightening it can sign people out, and
  // loosening it removes a control — a reviewer needs to see which happened.
  audit(req, 'org.mfa_policy.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      requireMfa: { from: before.requireMfa === true, to: effective.own },
      idpEnforcesMfa: { from: before.idpEnforcesMfa === true, to: effective.idpEnforcesMfa },
      adminActionsRequireMfa: { from: before.adminActionsRequireMfa === true, to: effective.adminActionsOwn },
      ...(adminActionsChanged ? { sessionsRefreshed } : {}),
      ...(effective.graceUntil ? { graceUntil: effective.graceUntil.toISOString() } : {}),
    },
  });
  incCounter('platform_mfa_policy_changes_total', { requireMfa: String(effective.own) });
  logger.info('MFA policy updated', { orgId: id, by: req.user!.sub, requireMfa: effective.own, enforced: effective.enforced });

  sendSuccess(
    res, 200, { ...(await mfaPolicyView(effective)), ...(adminActionsChanged ? { sessionsRefreshed } : {}) },
    effective.inheritedFrom
      ? 'Two-factor policy updated — a parent organization also requires it, and that requirement applies as well'
      : 'Two-factor policy updated',
  );
}, {
  [MFA_BOOTSTRAP_STILL_OPEN]: {
    status: 409,
    message: 'The bootstrap administrator has not enrolled a factor yet. Enrol a passkey or an authenticator app first, '
      + 'otherwise requiring two-factor authentication here would lock the only account that can set one up out of the platform.',
    code: 'MFA_BOOTSTRAP_STILL_OPEN',
  },
});

