/**
 * @module helpers/stripe-helpers
 * @description Helpers for Stripe payment provider integration.
 *
 * Maps Stripe subscription statuses and events to internal billing types.
 */

import { createLogger } from '@mwashburn160/api-core';
import { Subscription } from '../models/subscription';
import type { SubscriptionStatus } from '../models/subscription';

const logger = createLogger('stripe-helpers');

/**
 * Map a Stripe subscription status to our internal SubscriptionStatus.
 * @see https://docs.stripe.com/api/subscriptions/object#subscription_object-status
 */
export function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
      return 'canceled';
    case 'incomplete':
    case 'incomplete_expired':
      return 'incomplete';
    default:
      logger.warn('Unknown Stripe subscription status', { stripeStatus });
      return 'incomplete';
  }
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
