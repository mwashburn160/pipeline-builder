// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import type Stripe from 'stripe';
import { Subscription } from '../models/subscription.js';
import type { SubscriptionStatus, SubscriptionDocument } from '../models/subscription.js';

const logger = createLogger('stripe-helpers');

/** Stripe status → internal SubscriptionStatus lookup.
 *  `unpaid` maps to `canceled` (not `past_due`): Stripe sets `unpaid` only
 *  after the configured grace period has expired with the invoice still
 *  unpaid, so by our policy the subscription is gone and tier should
 *  downgrade — same as an explicit cancel. */
const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete',
};

/**
 * Map a Stripe subscription status to our internal SubscriptionStatus.
 * @see https://docs.stripe.com/api/subscriptions/object#subscription_object-status
 */
export function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  const mapped = STRIPE_STATUS_MAP[stripeStatus];
  if (!mapped) {
    logger.warn('Unknown Stripe subscription status', { stripeStatus });
    return 'incomplete';
  }
  return mapped;
}

/**
 * Find a subscription by its Stripe external ID.
 */
export async function findSubscriptionByStripeId(stripeSubscriptionId: string) {
  return Subscription.findOne({
    'externalId': stripeSubscriptionId,
    'metadata.provider': 'stripe',
  });
}

/** The envelope fields of a verified Stripe event the lifecycle handlers need. */
export interface StripeEventMeta {
  id: string;
  /** Event creation time, Unix SECONDS (Stripe's `event.created`). */
  created: number;
}

/**
 * Per-subscription ordering guard for Stripe lifecycle events. Stripe does NOT
 * deliver events in order (and retries interleave), so an old
 * `customer.subscription.updated`→past_due landing after the recovering
 * `invoice.payment_succeeded` would re-open dunning on a paid subscription.
 *
 * Atomically advances `lastStripeEventAt` to the event's `created` when it is
 * not OLDER than the stored watermark, and reports whether the event may be
 * applied. Equal timestamps pass (Stripe stamps whole seconds, so a create and
 * its first update often share one) and so does a retry of the event that set
 * the watermark. Callers then save the document normally — Mongoose writes only
 * modified paths, so the handler's save can't roll the watermark back.
 */
export async function claimStripeEventOrder(subscriptionId: SubscriptionDocument['_id'], event: StripeEventMeta): Promise<boolean> {
  const at = new Date(event.created * 1000);
  const res = await Subscription.updateOne(
    { _id: subscriptionId, $or: [{ lastStripeEventAt: null }, { lastStripeEventAt: { $lte: at } }] },
    { $set: { lastStripeEventAt: at } },
  );
  return res.matchedCount > 0;
}

/**
 * Resolve the subscription a charge-level reversal (charge.refunded /
 * charge.dispute.created) should CLAW BACK against. A Charge/Dispute carries the
 * customer but NOT the subscription, so a customer with exactly ONE Stripe
 * subscription is an unambiguous match. With MULTIPLE rows sharing the customer
 * (cancel→resubscribe), newest-by-customer could be a DIFFERENT subscription than
 * the one this charge belongs to — clawing back the wrong sub's promotions. In
 * that case we report `ambiguous` so the caller reverses the (invoice-keyed)
 * ledger but SKIPS the sub-scoped clawback rather than attributing it wrong.
 *
 * `.limit(2)` is enough to distinguish "one" from "more than one".
 */
export async function findReversalSubscription(
  externalCustomerId: string,
): Promise<{ subscription: SubscriptionDocument | null; ambiguous: boolean }> {
  const subs = await Subscription.find({
    'externalCustomerId': externalCustomerId,
    'metadata.provider': 'stripe',
  }).sort({ createdAt: -1 }).limit(2);
  if (subs.length === 0) return { subscription: null, ambiguous: false };
  if (subs.length > 1) return { subscription: null, ambiguous: true };
  return { subscription: subs[0], ambiguous: false };
}

/**
 * The subscription id carried on an invoice, whether Stripe expanded it or sent
 * a bare id. Lives here (rather than in the webhook route) because both the
 * route and `stripe-reversals.ts` read it.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const sub = invoice.parent?.subscription_details?.subscription;
  return typeof sub === 'string' ? sub : sub?.id;
}
