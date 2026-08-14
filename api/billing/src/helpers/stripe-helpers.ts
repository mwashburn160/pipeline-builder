// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Subscription } from '../models/subscription.js';
import type { SubscriptionStatus } from '../models/subscription.js';

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
 * Find the account's newest Stripe subscription by its external customer id — the
 * lookup the charge-level reversal webhooks (charge.refunded /
 * charge.dispute.created) use, since a Charge/Dispute carries the customer but not
 * the subscription. Newest-first so a cancel→resubscribe (multiple rows sharing a
 * customer) resolves to the current subscription, not a stale canceled one.
 */
export async function findSubscriptionByCustomerId(externalCustomerId: string) {
  return Subscription.findOne({
    'externalCustomerId': externalCustomerId,
    'metadata.provider': 'stripe',
  }).sort({ createdAt: -1 });
}
