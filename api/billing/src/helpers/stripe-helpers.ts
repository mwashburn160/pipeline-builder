import { createLogger } from '@mwashburn160/api-core';
import { Subscription } from '../models/subscription';
import type { SubscriptionStatus } from '../models/subscription';

const logger = createLogger('stripe-helpers');

/** Stripe status → internal SubscriptionStatus lookup. */
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
