// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's "require MFA" policy (#8) — read and update.
 *
 *   GET   /organization/:id/mfa-policy
 *   PATCH /organization/:id/mfa-policy
 *
 * The policy is enforced where a token is ISSUED, never per route: a session
 * scoped to this org is minted at `aal: 2` or refused (see `utils/token.ts`).
 * These two endpoints are only how the setting is read and written.
 *
 * Both are gated on `org:settings` plus step-up at the route, and on
 * `canAdministerOrg` here — the same tenancy rule the impersonation policy uses,
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
import { isBootstrapExceptionOpen } from '../helpers/bootstrap-admin.js';
import { canAdministerOrg, requireAuth, withController } from '../helpers/controller-helper.js';
import { DEFAULT_MFA_GRACE_DAYS, resolveEffectiveMfaPolicy } from '../helpers/mfa-policy.js';
import { getOrgName } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { Organization, User } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import { refreshAdminPolicyClaims } from '../services/admin-mfa-claims.js';
import { MFA_BOOTSTRAP_STILL_OPEN } from '../services/auth-errors.js';
import { updateMfaPolicySchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-mfa-policy');

/**
 * How many of the org's active members could satisfy the requirement today.
 *
 * An admin choosing a grace period is deciding how long people need to enrol,
 * and the settings page could not tell them whether that was everyone or nobody
 * — so "14 days" was a guess. Counted here rather than on a route of its own:
 * it is exactly the context for the policy this endpoint already returns, and it
 * is read by the same `org:settings` admin.
 *
 * ENROLLED = holds a passkey or a CONFIRMED authenticator enrolment, i.e. what
 * `utils/token.ts` will accept at issuance. Password-only accounts are the ones
 * the deadline will refuse.
 */
async function enrolment(orgId: string): Promise<{ members: number; enrolled: number }> {
  const { UserOrganization, WebAuthnCredential, UserTotp } = await import('../models/index.js');
  const memberships = await UserOrganization
    .find({ organizationId: toOrgId(orgId), isActive: true })
    .select('userId')
    .lean();
  const userIds = memberships.map((m) => m.userId);
  if (userIds.length === 0) return { members: 0, enrolled: 0 };

  const [withPasskey, withTotp] = await Promise.all([
    WebAuthnCredential.distinct('userId', { userId: { $in: userIds } }),
    UserTotp.distinct('userId', { userId: { $in: userIds }, activatedAt: { $ne: null } }),
  ]);
  // A person with BOTH factors is one person; the union is the count.
  const enrolled = new Set([...withPasskey, ...withTotp].map(String));
  return { members: userIds.length, enrolled: enrolled.size };
}

/** The wire shape — dates as ISO strings, and the grace deadline spelled out so
 *  the member-facing banner needs no second call. */
async function view(policy: Awaited<ReturnType<typeof resolveEffectiveMfaPolicy>>) {
  // Name the parent that imposes the requirement, so the UI needn't resolve an
  // org the admin may not be able to read.
  const inheritedFromName = policy.inheritedFrom ? await getOrgName(policy.inheritedFrom) : undefined;
  const adminActionsInheritedFromName = policy.adminActionsInheritedFrom
    ? await getOrgName(policy.adminActionsInheritedFrom)
    : undefined;
  return {
    requireMfa: policy.requireMfa,
    enforced: policy.enforced,
    own: policy.own,
    idpEnforcesMfa: policy.idpEnforcesMfa,
    ...(policy.graceUntil ? { graceUntil: policy.graceUntil.toISOString() } : {}),
    ...(policy.requiredSince ? { requiredSince: policy.requiredSince.toISOString() } : {}),
    ...(policy.inheritedFrom ? { inheritedFrom: policy.inheritedFrom } : {}),
    ...(inheritedFromName ? { inheritedFromName } : {}),
    adminActionsRequireMfa: policy.adminActionsRequireMfa,
    adminActionsOwn: policy.adminActionsOwn,
    ...(policy.adminActionsInheritedFrom ? { adminActionsInheritedFrom: policy.adminActionsInheritedFrom } : {}),
    ...(adminActionsInheritedFromName ? { adminActionsInheritedFromName } : {}),
    defaultGraceDays: DEFAULT_MFA_GRACE_DAYS,
  };
}

export const getMfaPolicy = withController('Get MFA policy', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'You can only view the policy of an organization you administer');
  }
  if (!(await Organization.exists({ _id: toOrgId(id) }))) return sendError(res, 404, 'Organization not found');

  // Both the org's OWN setting and what actually governs: a team's policy can be
  // tightened by a parent, so returning only `own` would let an admin set it off
  // and never learn why members are still being asked for a second factor. The
  // enrolment counts ride along so the grace-period decision has a number.
  const [policy, counts] = await Promise.all([resolveEffectiveMfaPolicy(id), enrolment(id)]);
  sendSuccess(res, 200, { ...(await view(policy)), enrolment: counts });
});

export const updateMfaPolicy = withController('Update MFA policy', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'You can only change the policy of an organization you administer');
  }

  const body = validateBody(updateMfaPolicySchema, req.body, res);
  if (!body) return;

  const before = await Organization.findById(toOrgId(id))
    .select('requireMfa mfaGraceUntil idpEnforcesMfa adminActionsRequireMfa isSystem').lean();
  if (!before) return sendError(res, 404, 'Organization not found');

  const turningOn = body.requireMfa === true && before.requireMfa !== true;

  // Weakening needs a session opened with a second factor (see the module doc).
  if (isLoosening(before, body) && refuseWeakSession(req, res, { minAssurance: 2 })) return;

  // REFUSE THE LOCKOUT. While the bootstrap-admin exception is still open, the
  // install's only admin has no factor — turning the requirement on for the
  // SYSTEM org would refuse their next sign-in and leave nobody able to close
  // the exception. They enrol first; then this is allowed.
  if (turningOn && before.isSystem === true && await anyOpenBootstrapException()) {
    throw new Error(MFA_BOOTSTRAP_STILL_OPEN);
  }

  const now = new Date();
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  if (body.requireMfa !== undefined) {
    set.requireMfa = body.requireMfa;
    if (turningOn) {
      // The deadline is computed HERE from a day count, so a client can never
      // post a deadline of its own — including one already in the past, which
      // would turn "enable with a grace period" into an instant lockout.
      const graceDays = body.graceDays ?? DEFAULT_MFA_GRACE_DAYS;
      set.mfaRequiredSince = now;
      if (graceDays > 0) set.mfaGraceUntil = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);
      else unset.mfaGraceUntil = '';
    } else if (body.requireMfa === false) {
      // Turning it off clears the deadline too: a grace period that outlives the
      // requirement would silently resume it if the policy were re-enabled.
      unset.mfaRequiredSince = '';
      unset.mfaGraceUntil = '';
    }
  }
  if (body.idpEnforcesMfa !== undefined) set.idpEnforcesMfa = body.idpEnforcesMfa;
  if (body.adminActionsRequireMfa !== undefined) set.adminActionsRequireMfa = body.adminActionsRequireMfa;

  await Organization.updateOne(
    { _id: toOrgId(id) },
    {
      ...(Object.keys(set).length > 0 ? { $set: set } : {}),
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    },
  );

  const effective = await resolveEffectiveMfaPolicy(id);

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
    res, 200, { ...(await view(effective)), ...(adminActionsChanged ? { sessionsRefreshed } : {}) },
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

/**
 * Whether a policy update WEAKENS the org's protection, and therefore needs an
 * `aal: 2` session:
 *   - turning "require MFA" off;
 *   - turning "administrative actions require MFA" off;
 *   - stating that the org's IdP enforces MFA — from then on an SSO sign-in
 *     counts as `aal: 2` on the org's word rather than on a factor we verified.
 * Everything else (turning a requirement on, withdrawing the IdP statement) only
 * tightens, and stays open to a single-factor admin.
 */
export function isLoosening(
  before: { requireMfa?: boolean; idpEnforcesMfa?: boolean; adminActionsRequireMfa?: boolean },
  body: { requireMfa?: boolean; idpEnforcesMfa?: boolean; adminActionsRequireMfa?: boolean },
): boolean {
  return (body.requireMfa === false && before.requireMfa === true)
    || (body.adminActionsRequireMfa === false && before.adminActionsRequireMfa === true)
    || (body.idpEnforcesMfa === true && before.idpEnforcesMfa !== true);
}

/**
 * Whether ANY bootstrap-authorized account still has the exception open. Checked
 * rather than "the caller's own", because the account that would be locked out
 * is whichever bootstrap admin has no factor — not necessarily the one making
 * this request.
 */
async function anyOpenBootstrapException(): Promise<boolean> {
  const raw = process.env.BOOTSTRAP_SUPERADMIN_EMAILS || '';
  const emails = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (emails.length === 0) return false;
  const users = await User.find({ email: { $in: emails } }).select('email mfaBootstrapClosedAt').lean();
  for (const u of users) {
    if (await isBootstrapExceptionOpen(u as Parameters<typeof isBootstrapExceptionOpen>[0])) return true;
  }
  return false;
}
