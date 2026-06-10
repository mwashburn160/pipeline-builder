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
