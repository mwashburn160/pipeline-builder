// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
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
