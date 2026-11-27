// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * BILLING the support size floor — once per billing period.
 *
 * `supportFloorLine` computes the floor's top-up and `priceBreakdown` / `GET
 * /charges` show it, but nothing ever CHARGED it: support contacts bill as
 * Stripe line items, volume and combo reductions are realized as usage credits,
 * and the floor — the one adjustment that ADDS money — had no realization at
 * all. An account the floor binds on saw a total it was never invoiced.
 *
 * WHEN. On the settled invoice that opens a billing period, keyed by that
 * period (`invoiceCreditPeriodKey`) — the same trigger and key the per-period
 * volume and combo credits use, so the floor and the reductions it mirrors move
 * together. The top-up for the period is added to the subscription's NEXT
 * invoice as a labelled line; the interval's months are already inside the
 * figure (`supportFloorLine` prices the interval: 1 month, or 10 for annual), so
 * it is billed exactly once per interval, never once per month of an annual one.
 *
 * ONCE. The period is CLAIMED on the subscription (`supportFloorCharges`) in a
 * guarded write before the provider is called, so a redelivered webhook or a
 * second invoice in the same period (a proration, a one-off) finds the claim and
 * charges nothing. The provider call is idempotency-keyed on (subscription,
 * period) too. A failed post releases the claim and throws, so the webhook
 * answers 500 and Stripe's redelivery retries it — every other effect of that
 * webhook is idempotent on its own key.
 *
 * NEVER FOR NOTHING. Only an entitled subscription that has not lapsed into the
 * grace downgrade is charged, and only when the floor binds — `supportFloorLine`
 * already returns null for an account holding no support.
 */

import { createLogger, emitCounter } from '@pipeline-builder/api-core';
import { createBillingEvent, getBundleCatalog } from './billing-helpers.js';
import { getComboDiscounts } from './combo-pricing.js';
import { MANAGEABLE_SUBSCRIPTION_STATUSES, isGraceDowngraded } from './subscription-status.js';
import { supportFloorLine } from './support-floor.js';
import { Plan } from '../models/plan.js';
import { Subscription, type SubscriptionDocument } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('support-floor-charge');

/** How many billed support-floor periods a subscription keeps: two years of
 *  monthly periods, far beyond any webhook redelivery window. */
export const SUPPORT_FLOOR_CHARGE_HISTORY = 24;

export type SupportFloorChargeOutcome =
  | { status: 'charged'; cents: number }
  | { status: 'none' | 'already_charged' | 'unrealizable' };

/** The provider idempotency key for one subscription's floor in one period. */
export function supportFloorChargeKey(subscriptionId: string, periodKey: string): string {
  return `support-floor-${subscriptionId}-${periodKey}`;
}

/**
 * Charge the support size floor's top-up for `periodKey`, at most once. See the
 * module comment. Throws only when the provider refused the charge (the claim is
 * released first, so a retry can charge it).
 */
export async function chargeSupportFloorForPeriod(
  subscription: SubscriptionDocument,
  periodKey: string,
): Promise<SupportFloorChargeOutcome> {
  if (!(MANAGEABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status)) return { status: 'none' };
  // A lapsed account carries no paid entitlement (support included), so it owes no floor on it.
  if (isGraceDowngraded(subscription)) return { status: 'none' };
  if ((subscription.supportFloorCharges ?? []).some((c) => c.periodKey === periodKey)) return { status: 'already_charged' };

  const plan = await Plan.findById(subscription.planId).lean();
  if (!plan) return { status: 'none' };
  const line = supportFloorLine(
    plan.tier, subscription.addons ?? [], getBundleCatalog(), subscription.interval,
    undefined, subscription.supportFloorOverride, getComboDiscounts(),
  );
  if (!line || !(line.cents > 0)) return { status: 'none' };

  if (line.stale) {
    // The negotiated floor is honoured, but the account has outgrown the seat
    // count it was agreed at — counted so somebody renegotiates instead of
    // discovering it at renewal.
    emitCounter('billing_support_floor_override_stale_total');
    logger.warn('Negotiated support floor is stale — the account has outgrown the agreed seats', { orgId: subscription.orgId });
  }

  const provider = getPaymentProvider();
  if (!provider.addInvoiceCharge || !subscription.externalCustomerId || !subscription.externalId) {
    // No invoice of our own to add a line to (Marketplace bills through AWS
    // contracts). Reported, never silently waived.
    emitCounter('billing_support_floor_unrealizable_total');
    logger.warn('Support size floor binds but the provider cannot bill it', { orgId: subscription.orgId, periodKey });
    return { status: 'unrealizable' };
  }

  // CLAIM the period before charging: the guard is what makes a redelivered or
  // concurrent webhook for the same period charge nothing.
  const claimed = await Subscription.findOneAndUpdate(
    { '_id': subscription._id, 'supportFloorCharges.periodKey': { $ne: periodKey } },
    { $push: { supportFloorCharges: { $each: [{ periodKey, cents: line.cents, at: new Date() }], $slice: -SUPPORT_FLOOR_CHARGE_HISTORY } } },
  );
  if (!claimed) return { status: 'already_charged' };

  let ref: string;
  try {
    ({ ref } = await provider.addInvoiceCharge(
      subscription.externalCustomerId,
      subscription.externalId,
      line.cents,
      line.label,
      supportFloorChargeKey(subscription._id.toString(), periodKey),
    ));
  } catch (err) {
    // Give the period back so the redelivery can charge it.
    await Subscription.updateOne({ _id: subscription._id }, { $pull: { supportFloorCharges: { periodKey, providerRef: { $exists: false } } } });
    emitCounter('billing_support_floor_charge_failed_total');
    throw err;
  }
  await Subscription.updateOne(
    { '_id': subscription._id, 'supportFloorCharges.periodKey': periodKey },
    { $set: { 'supportFloorCharges.$.providerRef': ref } },
  );
  await createBillingEvent(subscription.orgId, 'subscription_updated', {
    reason: 'support_floor_charged',
    periodKey,
    cents: line.cents,
    billableSeats: line.billableSeats,
    negotiated: line.negotiated,
  }, subscription._id.toString());
  emitCounter('billing_support_floor_charged_total');
  logger.info('Support size floor charged for the period', { orgId: subscription.orgId, periodKey });
  return { status: 'charged', cents: line.cents };
}
