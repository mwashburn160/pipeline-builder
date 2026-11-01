// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One-time support incidents: a consumable stock of single support cases.
 *
 * WHY A BALANCE AND NOT A QUOTA. The obvious implementation is wrong. Every
 * entry in api-core's `VALID_QUOTA_TYPES` is a per-period FLOW counter reset on
 * `QUOTA_RESET_DAYS` (default **3**), so an incident modelled as a quota would
 * be re-granted every three days — unlimited incidents sold as one. The other
 * candidate, `supportContacts`, is a tier LIMIT like `seats`: nothing ever
 * decrements it. Neither shape expresses "a stock that is spent once", so this
 * mirrors `creditBalanceCents` — a balance on the subscription, incremented by a
 * grant and conditionally decremented on use.
 *
 * WHY IT IS A SECOND DOOR. Opening a case normally requires a designated
 * support contact, and `supportContacts` has a tier base of 0 everywhere — so an
 * org with no support add-on cannot open one. An incident bypasses that
 * deliberately: it serves the customer who needs a single answer and holds no
 * subscription. The case-open check is therefore "has a contact seat OR can
 * spend an incident", not one or the other.
 *
 * NOT SOLD — A CONCESSION INSTRUMENT, BY DECISION. Incidents are granted, never
 * purchased, and that is settled rather than pending. Pricing one is a squeeze
 * with an empty middle: monthly support cancels freely (`cancelAtPeriodEnd`, no
 * minimum term anywhere in billing), so any incident priced above a month of
 * Standard ($19.99, unlimited cases) is economically dominated — a buyer
 * subscribes for one month and cancels. Priced below it, an incident loses money
 * on every use, since one human reply is $15-40 of loaded engineer time with no
 * subscription revenue to amortise against.
 *
 * So the use is goodwill after an outage, a trial for a prospect evaluating
 * support, or a make-good for a missed response target. If a sellable
 * per-incident SKU is ever wanted it needs BOTH a one-off charge path (billing
 * has no invoice-item or one-off concept; bundles bill as recurring line items)
 * and a reason not to be dominated — a minimum term on monthly support, or a
 * service level no tier offers. `grantSupportIncidents` is the seam either would
 * call.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { MANAGEABLE_SUBSCRIPTION_STATUSES } from './subscription-status.js';
import { Subscription } from '../models/subscription.js';

const logger = createLogger('support-incidents');

/** Upper bound on a single grant — a fat-finger guard, not a business rule. */
export const MAX_INCIDENT_GRANT = 100;

/**
 * Add `count` incidents to an org's balance. Returns the new balance, or `null`
 * when the org has no manageable subscription to hold it.
 *
 * `$inc` rather than read-modify-write so two concurrent grants cannot lose one
 * — the same reason `creditBalanceCents` is incremented this way.
 */
export async function grantSupportIncidents(
  orgId: string,
  count: number,
  actorId?: string,
): Promise<number | null> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_INCIDENT_GRANT) {
    throw new Error(`count must be an integer in 1..${MAX_INCIDENT_GRANT}`);
  }
  const updated = await Subscription.findOneAndUpdate(
    { orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } },
    { $inc: { supportIncidentBalance: count } },
    { new: true },
  );
  if (!updated) {
    logger.warn('Support-incident grant skipped: no manageable subscription', { orgId, count });
    return null;
  }
  logger.info('Support incidents granted', { orgId, count, balance: updated.supportIncidentBalance, actorId });
  return updated.supportIncidentBalance;
}

/**
 * Spend exactly one incident. Returns `true` when one was spent, `false` when
 * the org had none — the caller refuses the case open in that case.
 *
 * The `$gte: 1` guard lives in the QUERY, not in a prior read: a filtered
 * `findOneAndUpdate` is a single atomic operation, so two concurrent case opens
 * against a balance of 1 cannot both succeed. Reading the balance and then
 * decrementing would let both through, which is a free support case per race.
 * The schema's `min: 0` is a backstop, not the mechanism — it would only ever
 * reject a write that this guard should already have prevented.
 */
export async function consumeSupportIncident(orgId: string, actorId?: string): Promise<boolean> {
  const updated = await Subscription.findOneAndUpdate(
    {
      orgId,
      status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
      supportIncidentBalance: { $gte: 1 },
    },
    { $inc: { supportIncidentBalance: -1 } },
    { new: true },
  );
  if (!updated) return false;
  logger.info('Support incident consumed', { orgId, remaining: updated.supportIncidentBalance, actorId });
  return true;
}

/**
 * Give one incident back, for a case that was never actually worked — a
 * duplicate, or one closed as "not a support issue".
 *
 * Separate from `grantSupportIncidents` on purpose: a refund and a concession
 * are different events and want different audit actions, even though the
 * arithmetic is identical. Collapsing them would make "how many incidents did
 * we give away" unanswerable.
 */
export async function refundSupportIncident(orgId: string, actorId?: string): Promise<number | null> {
  const updated = await Subscription.findOneAndUpdate(
    { orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } },
    { $inc: { supportIncidentBalance: 1 } },
    { new: true },
  );
  if (!updated) return null;
  logger.info('Support incident refunded', { orgId, balance: updated.supportIncidentBalance, actorId });
  return updated.supportIncidentBalance;
}

/** The org's remaining incidents; 0 when it has no manageable subscription. */
export async function supportIncidentsRemaining(orgId: string): Promise<number> {
  const sub = await Subscription.findOne(
    { orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } },
    { supportIncidentBalance: 1 },
  ).lean();
  return sub?.supportIncidentBalance ?? 0;
}
