// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Support contacts: who in an org may raise and own a support case.
 *
 * WHY PLATFORM OWNS THIS. The same structural reasons `support-entitlement.ts`
 * gives, plus one more that only the WRITE side has: designating a contact
 * spends the account's paid allowance and must name a real member, and platform
 * is the only service holding both facts — the synced cap on the root org doc
 * and the `UserOrganization` membership edge. The message service, which owns
 * the support thread, has neither.
 *
 * WITHOUT THIS SURFACE THE ADD-ON DOES NOT WORK AT ALL. `canOpenCase` is
 * `ownOrgContacts > 0`, so an org with no designated contact can never open a
 * case however much support it has bought. `designateSupportContact` existed in
 * pipeline-data with no route and no caller, which made the whole ladder
 * unreachable: every support send landed as a plain message and incremented
 * `support_cases_total{action="unentitled"}`.
 *
 * THE TWO SCOPES, again, because they decide what each handler passes:
 *   - the CAP pools subtree-wide (an account buys contacts once and spends them
 *     anywhere beneath its root, like seats), so `canDesignate` is an
 *     account-level question answered by `supportEntitlement`;
 *   - OWNERSHIP is own-org, so the list and the revoke act on a single org id
 *     and never on the expanded subtree. A sibling team's contacts are not
 *     this org's to see or remove.
 */

import { getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import {
  countPremiumSupportContacts,
  designateSupportContact,
  listActiveSupportContacts,
  revokeSupportContact,
  setSupportContactPremium,
} from '@pipeline-builder/pipeline-data';
import { Types } from 'mongoose';
import { audit } from '../helpers/audit.js';
import { expandOrgScope, resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { ensureAuthenticated, requireOrgScope, withController } from '../helpers/controller-helper.js';
import { toOrgId } from '../helpers/org-id.js';
import { supportEntitlement } from '../helpers/support-entitlement.js';
import { User, UserOrganization } from '../models/index.js';

/**
 * The ACCOUNT SUBTREE an org's pooled support caps are measured over.
 *
 * Both caps pool at the root, so both counts have to span the whole subtree: an
 * upgrade spent in a sibling team is still spent. Mirrors what
 * `supportEntitlement` does internally; done here too because the premium count
 * is not part of that payload.
 */
async function supportScope(orgId: string): Promise<string[]> {
  const { rootOrgId } = await resolveOrgLineage(orgId);
  return (await expandOrgScope(rootOrgId)).map(String);
}

/** A 24-hex id, or null — the shape every id below has to clear first. */
function objectId(value: unknown): Types.ObjectId | null {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value) ? new Types.ObjectId(value) : null;
}

/**
 * GET /organization/:id/support-contacts
 *
 * The org's own live contacts, with names, plus the allowance so the UI can say
 * "3 of 5 used" without a second call. Both scopes are in the payload and are
 * labelled: `limit`/`used` are the pooled account figures, `contacts` is this
 * org only.
 */
export const listSupportContacts = withController('List support contacts', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOrgScope(req, res, orgId))) return;

  const [entitlement, contacts, premiumUsed] = await Promise.all([
    supportEntitlement(orgId),
    listActiveSupportContacts([String(toOrgId(orgId))]),
    // The POOLED premium count, measured over the same subtree the cap is: an
    // upgrade spent in a sibling team is still spent.
    countPremiumSupportContacts(await supportScope(orgId)),
  ]);

  // Names, resolved in one query. A list of raw user ids is unusable as a
  // picker, and the transfer control in the message UI reads the same shape.
  const ids = contacts.map((c) => objectId(c.userId)).filter((v): v is Types.ObjectId => v !== null);
  // `username` + `email`: there is no first/last name on the User model, and the
  // picker needs something a human recognises next to the address.
  const users = ids.length
    ? await User.find({ _id: { $in: ids } }).select('username email').lean()
    : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));

  sendSuccess(res, 200, {
    level: entitlement.level,
    // The premium UPGRADE, reported separately from the baseline level because
    // that is what it is: the account holds one baseline for all its contacts
    // and may upgrade `premiumLimit` of them to 24x7.
    premium: entitlement.premium,
    premiumLimit: entitlement.premiumLimit,
    premiumUsed,
    // Whether another contact may be upgraded: the premium cap's counterpart to
    // `canDesignate`, and pooled the same way.
    canUpgrade: entitlement.premium
      && (entitlement.premiumLimit === -1 || premiumUsed < entitlement.premiumLimit),
    // The POOLED cap, which is the account's, not this org's.
    limit: entitlement.limit,
    used: entitlement.used,
    canDesignate: entitlement.canDesignate,
    contacts: contacts.map((c) => {
      const u = byId.get(c.userId);
      return {
        userId: c.userId,
        isPremium: c.isPremium,
        email: u?.email ?? null,
        // Null rather than the raw id when the user is gone: a deleted account
        // still has a contact row (revoked rows are kept as the record that
        // somebody once held the slot), and showing a bare ObjectId as a name
        // would read as a person.
        username: u?.username ?? null,
      };
    }),
  });
});

/**
 * POST /organization/:id/support-contacts  { userId }
 *
 * Designate a member as a support contact.
 *
 * Four checks, in this order, because each would produce a worse error if moved:
 * tenancy (is this org yours to administer), entitlement (did the account buy a
 * level at all), the pooled cap (is there room), then membership (is the target
 * actually in this org). Membership is last because it is the only one that
 * needs a second query and the only one a caller can fix by picking someone
 * else.
 */
export const addSupportContact = withController('Designate support contact', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOrgScope(req, res, orgId))) return;

  const userId = (req.body as { userId?: unknown } | undefined)?.userId;
  const targetId = objectId(userId);
  if (!targetId) return sendError(res, 400, 'userId must be a 24-character user id');

  const entitlement = await supportEntitlement(orgId);
  if (!entitlement.level) {
    // Named rather than a bare 403: "no support add-on" and "all contacts used"
    // are different problems with different fixes, and an admin who cannot tell
    // them apart buys the wrong thing.
    return sendError(res, 403, 'This account has no support add-on. Buy a support level in Billing first.');
  }
  if (!entitlement.canDesignate) {
    return sendError(
      res,
      403,
      `All ${entitlement.limit} support contacts are in use across this account. Remove one, or add contacts in Billing.`,
    );
  }

  // Membership, not merely existence: a support contact speaks for this org, so
  // a user from another tenant must not be nominated. The allowance pools across
  // the subtree but ownership does not, so this is the OWN org's membership edge.
  const member = await UserOrganization.findOne({
    userId: targetId,
    organizationId: toOrgId(orgId),
    isActive: true,
  }).select('_id').lean();
  if (!member) return sendError(res, 404, 'That user is not an active member of this organization');

  // Optional premium UPGRADE at designation time, capped separately. Refused
  // rather than silently downgraded: an admin who asked for 24x7 and got
  // business hours would not find out until a 3am case went unanswered.
  const wantsPremium = (req.body as { premium?: unknown } | undefined)?.premium === true;
  if (wantsPremium) {
    const refusal = await premiumUpgradeRefusal(orgId, entitlement);
    if (refusal) return sendError(res, 403, refusal);
  }

  await designateSupportContact(String(toOrgId(orgId)), String(targetId), req.user!.sub, wantsPremium);

  audit(req, 'support.contact.designate', {
    targetType: 'support_contact',
    targetId: String(targetId),
    affectedOrgId: orgId,
    // The level and the cap at the moment of designation: a later dispute about
    // who was entitled to raise a case turns on what was true when they were
    // nominated, not on what the account holds today.
    details: {
      level: entitlement.level,
      limit: entitlement.limit,
      usedBefore: entitlement.used,
      premium: wantsPremium,
    },
  });
  sendSuccess(res, 201, { userId: String(targetId), isPremium: wantsPremium }, 'Support contact added');
});

/**
 * DELETE /organization/:id/support-contacts/:userId
 *
 * Revoke a designation, freeing the slot.
 *
 * Deliberately NOT blocked on the contact's open cases (scope C4): refusing to
 * remove a departed employee because they still own cases would be worse than
 * handing the cases on. The response carries those cases so the caller can
 * reassign them, and the count is audited — an orphaned case is then a known
 * fact rather than a discovery.
 */
export const removeSupportContact = withController('Revoke support contact', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOrgScope(req, res, orgId))) return;

  const targetId = objectId(getParam(req.params, 'userId'));
  if (!targetId) return sendError(res, 400, 'userId must be a 24-character user id');

  const { revoked, openCases } = await revokeSupportContact(
    String(toOrgId(orgId)),
    String(targetId),
    req.user!.sub,
  );
  if (!revoked) return sendError(res, 404, 'That user is not a support contact for this organization');

  audit(req, 'support.contact.revoke', {
    targetType: 'support_contact',
    targetId: String(targetId),
    affectedOrgId: orgId,
    details: { openCasesLeftBehind: openCases.length },
  });
  sendSuccess(
    res,
    200,
    {
      userId: String(targetId),
      // Thread ids, not whole cases: the caller needs to know WHICH cases to
      // reassign, and the case bodies are the message service's to serve.
      openCases: openCases.map((c) => ({ threadId: c.threadId, displayNumber: c.displayNumber, status: c.status })),
    },
    openCases.length
      ? `Support contact removed. ${openCases.length} open case(s) still name them — reassign those.`
      : 'Support contact removed',
  );
});

/**
 * Why an upgrade cannot be granted right now, or null when it can.
 *
 * Separated from the handlers because designation and the explicit upgrade route
 * both need it and must refuse for the same reasons in the same words.
 */
async function premiumUpgradeRefusal(
  orgId: string,
  entitlement: { premium: boolean; premiumLimit: number },
): Promise<string | null> {
  if (!entitlement.premium) {
    return 'This account has no Premium Support upgrade. Add it in Billing — it is bought per upgraded contact, on top of your support level.';
  }
  if (entitlement.premiumLimit === -1) return null;
  const used = await countPremiumSupportContacts(await supportScope(orgId));
  if (used >= entitlement.premiumLimit) {
    return `All ${entitlement.premiumLimit} Premium Support upgrade(s) are in use across this account. Downgrade one, or add upgrades in Billing.`;
  }
  return null;
}

/**
 * PATCH /organization/:id/support-contacts/:userId  { premium: boolean }
 *
 * Upgrade or downgrade an existing contact.
 *
 * A separate verb from designation because the two answer to different caps and
 * fail for different reasons: designation is bounded by `supportContacts`, this
 * by `supportPremiumContacts`. An admin at the contact cap can still move an
 * upgrade between the people they already have, and conversely.
 *
 * DOWNGRADING NEVER WEAKENS AN OPEN CASE. `support_case.level` is frozen at
 * open, so a case this contact raised while upgraded keeps its 24x7 promise.
 * That is the point of freezing it, and it is why this route does not need to
 * touch a single case row.
 */
export const setSupportContactLevel = withController('Set support contact level', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOrgScope(req, res, orgId))) return;

  const targetId = objectId(getParam(req.params, 'userId'));
  if (!targetId) return sendError(res, 400, 'userId must be a 24-character user id');
  const premium = (req.body as { premium?: unknown } | undefined)?.premium;
  if (typeof premium !== 'boolean') return sendError(res, 400, 'premium must be true or false');

  const entitlement = await supportEntitlement(orgId);
  // Only the UPGRADE direction is capped. A downgrade frees a slot and must
  // always be available — otherwise an account that lost its premium add-on
  // could never tidy up the contacts still marked as upgraded.
  if (premium) {
    const refusal = await premiumUpgradeRefusal(orgId, entitlement);
    if (refusal) return sendError(res, 403, refusal);
  }

  const moved = await setSupportContactPremium(String(toOrgId(orgId)), String(targetId), premium);
  if (!moved) return sendError(res, 404, 'That user is not a support contact for this organization');

  audit(req, premium ? 'support.contact.upgrade' : 'support.contact.downgrade', {
    targetType: 'support_contact',
    targetId: String(targetId),
    affectedOrgId: orgId,
    // The cap as it stood: who was entitled to 24x7 and when is the fact a
    // response-time dispute turns on.
    details: { premium, premiumLimit: entitlement.premiumLimit },
  });
  sendSuccess(
    res,
    200,
    { userId: String(targetId), isPremium: premium },
    premium ? 'Contact upgraded to Premium Support' : 'Premium Support upgrade removed',
  );
});
