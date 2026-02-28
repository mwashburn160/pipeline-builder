/**
 * @module providers/stripe-provider
 * @description Stripe payment provider implementation.
 *
 * Stripe SaaS flow:
 * 1. We create a Stripe Customer for the organization
 * 2. We create a Subscription with the appropriate Price ID
 * 3. Stripe webhooks drive lifecycle changes (payment failures, cancellations)
 *
 * Key difference from AWS Marketplace: operations are pull-based (API calls
 * from our side), not push-based (SNS notifications).
 */

import Stripe from 'stripe';
import { createLogger } from '@mwashburn160/api-core';
import type { ExternalSubscriptionResult, PaymentProvider } from './payment-provider';
import type { StripeConfig } from '../config';
import type { BillingInterval } from '../models/subscription';

const logger = createLogger('stripe-provider');

export class StripeProvider implements PaymentProvider {
  private readonly stripe: Stripe;
  private readonly stripeConfig: StripeConfig;

  constructor(stripeConfig: StripeConfig) {
    this.stripeConfig = stripeConfig;
    this.stripe = new Stripe(stripeConfig.secretKey);
  }

  /**
   * Create a Stripe customer for the organization.
   * @returns The Stripe Customer ID (e.g., "cus_xxx")
   */
  async createCustomer(orgId: string, email: string): Promise<string> {
    logger.info('Creating Stripe customer', { orgId });

    const customer = await this.stripe.customers.create({
      email: email || undefined,
      metadata: { orgId },
    });

    logger.info('Stripe customer created', { orgId, customerId: customer.id });
    return customer.id;
  }

  /**
   * Create a Stripe subscription for the customer.
   * Looks up the Stripe Price ID from config using the "{planId}_{interval}" key.
   */
  async createSubscription(
    customerId: string,
    planId: string,
    interval: BillingInterval,
  ): Promise<ExternalSubscriptionResult> {
    const priceKey = `${planId}_${interval}`;
    const priceId = this.stripeConfig.priceToPlanMap[priceKey];

    if (!priceId) {
      throw new Error(
        `No Stripe Price ID configured for plan "${planId}" with interval "${interval}". `
        + `Expected key "${priceKey}" in STRIPE_PRICE_MAP.`,
      );
    }

    logger.info('Creating Stripe subscription', { customerId, planId, interval, priceId });

    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      metadata: { planId, interval },
    });

    logger.info('Stripe subscription created', {
      customerId,
      subscriptionId: subscription.id,
      status: subscription.status,
    });

    return {
      externalId: subscription.id,
      externalCustomerId: customerId,
    };
  }

  /**
   * Cancel a Stripe subscription at the end of the current billing period.
   */
  async cancelSubscription(externalId: string): Promise<void> {
    logger.info('Canceling Stripe subscription at period end', { externalId });

    await this.stripe.subscriptions.update(externalId, {
      cancel_at_period_end: true,
    });

    logger.info('Stripe subscription marked for cancellation', { externalId });
  }

  /**
   * Update a Stripe subscription to a new plan.
   * Replaces the existing subscription item with the new price.
   */
  async updateSubscription(externalId: string, planId: string): Promise<void> {
    logger.info('Updating Stripe subscription plan', { externalId, planId });

    const subscription = await this.stripe.subscriptions.retrieve(externalId);
    const currentItem = subscription.items.data[0];

    if (!currentItem) {
      throw new Error(`Stripe subscription ${externalId} has no items`);
    }

    // Look up the new price — try monthly first, then annual
    const interval = (subscription.metadata?.interval as BillingInterval) || 'monthly';
    const priceKey = `${planId}_${interval}`;
    const priceId = this.stripeConfig.priceToPlanMap[priceKey];

    if (!priceId) {
      throw new Error(
        `No Stripe Price ID configured for plan "${planId}" with interval "${interval}".`,
      );
    }

    await this.stripe.subscriptions.update(externalId, {
      items: [{ id: currentItem.id, price: priceId }],
      metadata: { planId, interval },
    });

    logger.info('Stripe subscription updated', { externalId, planId, priceId });
  }

  /**
   * Reactivate a Stripe subscription by removing the cancellation.
   */
  async reactivateSubscription(externalId: string): Promise<void> {
    logger.info('Reactivating Stripe subscription', { externalId });

    await this.stripe.subscriptions.update(externalId, {
      cancel_at_period_end: false,
    });

    logger.info('Stripe subscription reactivated', { externalId });
  }

  /** Expose the Stripe instance for webhook signature verification. */
  getStripeClient(): Stripe {
    return this.stripe;
  }

  /** Expose the webhook secret for signature verification. */
  getWebhookSecret(): string {
    return this.stripeConfig.webhookSecret;
  }
}
