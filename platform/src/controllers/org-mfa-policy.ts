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
 */

import { createLogger, getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { isBootstrapExceptionOpen } from '../helpers/bootstrap-admin.js';
import { canAdministerOrg, requireAuth, withController } from '../helpers/controller-helper.js';
import { DEFAULT_MFA_GRACE_DAYS, resolveEffectiveMfaPolicy } from '../helpers/mfa-policy.js';
import { toOrgId } from '../helpers/org-id.js';
import { Organization, User } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import { MFA_BOOTSTRAP_STILL_OPEN } from '../services/auth-errors.js';
import { updateMfaPolicySchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-mfa-policy');

/** The wire shape — dates as ISO strings, and the grace deadline spelled out so
 *  the member-facing banner needs no second call. */
function view(policy: Awaited<ReturnType<typeof resolveEffectiveMfaPolicy>>) {
  return {
    requireMfa: policy.requireMfa,
    enforced: policy.enforced,
    own: policy.own,
    idpEnforcesMfa: policy.idpEnforcesMfa,
    ...(policy.graceUntil ? { graceUntil: policy.graceUntil.toISOString() } : {}),
    ...(policy.requiredSince ? { requiredSince: policy.requiredSince.toISOString() } : {}),
    ...(policy.inheritedFrom ? { inheritedFrom: policy.inheritedFrom } : {}),
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
  // and never learn why members are still being asked for a second factor.
  sendSuccess(res, 200, view(await resolveEffectiveMfaPolicy(id)));
});

export const updateMfaPolicy = withController('Update MFA policy', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'You can only change the policy of an organization you administer');
  }

  const body = validateBody(updateMfaPolicySchema, req.body, res);
  if (!body) return;

  const before = await Organization.findById(toOrgId(id)).select('requireMfa mfaGraceUntil idpEnforcesMfa isSystem').lean();
  if (!before) return sendError(res, 404, 'Organization not found');

  const turningOn = body.requireMfa === true && before.requireMfa !== true;

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

  await Organization.updateOne(
    { _id: toOrgId(id) },
    {
      ...(Object.keys(set).length > 0 ? { $set: set } : {}),
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    },
  );

  const effective = await resolveEffectiveMfaPolicy(id);

  // Both sides of the transition: tightening it can sign people out, and
  // loosening it removes a control — a reviewer needs to see which happened.
  audit(req, 'org.mfa_policy.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      requireMfa: { from: before.requireMfa === true, to: effective.own },
      idpEnforcesMfa: { from: before.idpEnforcesMfa === true, to: effective.idpEnforcesMfa },
      ...(effective.graceUntil ? { graceUntil: effective.graceUntil.toISOString() } : {}),
    },
  });
  incCounter('platform_mfa_policy_changes_total', { requireMfa: String(effective.own) });
  logger.info('MFA policy updated', { orgId: id, by: req.user!.sub, requireMfa: effective.own, enforced: effective.enforced });

  sendSuccess(
    res, 200, view(effective),
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
