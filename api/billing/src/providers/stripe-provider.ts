// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import Stripe from 'stripe';
import type { ExternalSubscriptionResult, PaymentProvider } from './payment-provider.js';
import type { StripeConfig } from '../config.js';
import type { BillingInterval } from '../models/subscription.js';

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
  async createCustomer(orgId: string, email?: string, idempotencyKey?: string): Promise<string> {
    logger.info('Creating Stripe customer', { orgId });

    const customer = await this.stripe.customers.create({
      email: email || undefined,
      metadata: { orgId },
    }, idempotencyKey ? { idempotencyKey } : undefined);

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
    idempotencyKey?: string,
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
    }, idempotencyKey ? { idempotencyKey } : undefined);

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

  /**
   * Reconcile add-on line items on the Stripe subscription: keep the base plan
   * item (item[0], created at subscribe time), delete any prior bundle items,
   * and add the current bundles (price `<bundleId>_<interval>` × quantity).
   * Stripe prorates the change. Bundles with no configured price are skipped.
   */
  async syncAddons(
    externalId: string,
    addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
    interval: BillingInterval,
  ): Promise<void> {
    const subscription = await this.stripe.subscriptions.retrieve(externalId);
    const [baseItem, ...bundleItems] = subscription.items.data;
    if (!baseItem) throw new Error(`Stripe subscription ${externalId} has no items`);

    const items: Stripe.SubscriptionUpdateParams.Item[] = [{ id: baseItem.id }];
    // Remove all previously-added bundle line items (rebuilt below).
    for (const it of bundleItems) items.push({ id: it.id, deleted: true });
    // Add the current bundles.
    for (const { bundleId, quantity } of addons) {
      const priceId = this.stripeConfig.priceToPlanMap[`${bundleId}_${interval}`];
      if (!priceId) {
        logger.warn('No Stripe Price ID for bundle; skipping line item', { bundleId, interval });
        continue;
      }
      items.push({ price: priceId, quantity });
    }

    await this.stripe.subscriptions.update(externalId, {
      items,
      proration_behavior: 'create_prorations',
    });
    logger.info('Stripe add-ons synced', { externalId, addonCount: addons.length });
  }

  /**
   * Whether the customer can be charged: a default payment method on the
   * customer or its subscriptions, or at least one attached card. Fails CLOSED
   * (returns false) on a lookup error, so a paid add-on is never sold to an
   * account we can't confirm is chargeable.
   */
  async hasPaymentMethod(externalCustomerId: string): Promise<boolean> {
    try {
      const customer = await this.stripe.customers.retrieve(externalCustomerId);
      if (customer.deleted) return false;
      if (customer.invoice_settings?.default_payment_method) return true;
      if (customer.default_source) return true;
      const methods = await this.stripe.paymentMethods.list({ customer: externalCustomerId, limit: 1 });
      return methods.data.length > 0;
    } catch (err) {
      logger.warn('Stripe payment-method lookup failed; treating as no card on file', { externalCustomerId, error: String(err) });
      return false;
    }
  }

  /**
   * Create a Stripe Billing Portal session — the hosted page where a customer
   * adds/updates a card. Returns the URL to redirect them to. (The portal must be
   * enabled once in the Stripe dashboard; the API call itself needs no per-request
   * config beyond the customer + return URL.)
   */
  async createBillingPortalSession(externalCustomerId: string, returnUrl: string): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: externalCustomerId,
      return_url: returnUrl,
    });
    logger.info('Stripe billing portal session created', { externalCustomerId });
    return session.url;
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
