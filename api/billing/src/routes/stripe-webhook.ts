// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  errorMessage,
} from '@mwashburn160/api-core';
import { Router, Request, Response } from 'express';
import type Stripe from 'stripe';
import { config } from '../config';
import { createBillingEvent, calculatePeriodEnd, syncTierToQuotaService } from '../helpers/billing-helpers';
import { findSubscriptionByStripeId, mapStripeStatus } from '../helpers/stripe-helpers';
import { Plan } from '../models/plan';
import { getPaymentProvider } from '../providers/provider-factory';
import { StripeProvider } from '../providers/stripe-provider';

const logger = createLogger('billing-stripe-webhook');

/**
 * Return the active payment provider if it is a Stripe provider.
 */
function getStripeProvider(): StripeProvider | null {
  const provider = getPaymentProvider();
  return provider instanceof StripeProvider ? provider : null;
}

/**
 * Create the Stripe webhook router.
 *
 * Registers:
 * - POST /stripe/webhook -- receive Stripe webhook events
 * @returns Express Router
 */
export function createStripeWebhookRoutes(): Router {
  const router: Router = Router();

  router.post(
    '/stripe/webhook',
    async (req: Request, res: Response) => {
      const provider = getStripeProvider();
      if (!provider) {
        return sendError(
          res, 400,
          'Stripe provider is not configured',
          ErrorCode.VALIDATION_ERROR,
        );
      }

      const sig = req.headers['stripe-signature'];
      if (!sig) {
        return sendError(res, 400, 'Missing Stripe signature header', ErrorCode.VALIDATION_ERROR);
      }

      let event;
      try {
        const stripe = provider.getStripeClient();
        const webhookSecret = provider.getWebhookSecret();
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (error) {
        logger.warn('Stripe webhook signature verification failed', { error: errorMessage(error) });
        return sendError(res, 400, 'Invalid webhook signature', ErrorCode.VALIDATION_ERROR);
      }

      /** Stripe event type → handler dispatch map. */
      const eventHandlers: Record<string, (data: unknown) => Promise<void>> = {
        'customer.subscription.updated': (data) => handleSubscriptionUpdated(data as Stripe.Subscription),
        'customer.subscription.deleted': (data) => handleSubscriptionDeleted(data as Stripe.Subscription),
        'invoice.payment_succeeded': (data) => handlePaymentSucceeded(data as Stripe.Invoice),
        'invoice.payment_failed': (data) => handlePaymentFailed(data as Stripe.Invoice),
      };

      try {
        const handler = eventHandlers[event.type];
        if (handler) {
          await handler(event.data.object);
        } else {
          logger.debug('Unhandled Stripe event type', { type: event.type });
        }

        return sendSuccess(res, 200, { received: true });
      } catch (error) {
        logger.error('Failed to process Stripe webhook event', {
          type: event.type,
          error: errorMessage(error),
        });
        return sendError(res, 500, 'Failed to process webhook event', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  return router;
}

// Event Handlers

/**
 * Handle subscription updates from Stripe.
 * Syncs status changes, plan changes, and cancellation state.
 */
async function handleSubscriptionUpdated(stripeSubscription: Stripe.Subscription): Promise<void> {
  const externalId = stripeSubscription.id;
  const subscription = await findSubscriptionByStripeId(externalId);

  if (!subscription) {
    logger.warn('No subscription found for Stripe subscription', { externalId });
    return;
  }

  const previousStatus = subscription.status;
  const newStatus = mapStripeStatus(stripeSubscription.status);
  const cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end ?? false;

  let statusChanged = false;
  if (newStatus !== subscription.status) {
    subscription.status = newStatus;
    statusChanged = true;
  }

  if (cancelAtPeriodEnd !== subscription.cancelAtPeriodEnd) {
    subscription.cancelAtPeriodEnd = cancelAtPeriodEnd;
    statusChanged = true;
  }

  if (statusChanged) {
    await subscription.save();

    await createBillingEvent(subscription.orgId, 'subscription_updated', {
      provider: 'stripe',
      previousStatus,
      newStatus,
      cancelAtPeriodEnd,
      externalId,
    }, subscription._id.toString());

    logger.info('Stripe subscription status synced', {
      orgId: subscription.orgId,
      externalId,
      previousStatus,
      newStatus,
      cancelAtPeriodEnd,
    });
  }
}

/**
 * Handle subscription deletion from Stripe.
 * Marks subscription as canceled and downgrades the org to developer tier.
 */
async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription): Promise<void> {
  const externalId = stripeSubscription.id;
  const subscription = await findSubscriptionByStripeId(externalId);

  if (!subscription) {
    logger.warn('No subscription found for deleted Stripe subscription', { externalId });
    return;
  }

  const previousStatus = subscription.status;
  subscription.status = 'canceled';
  subscription.cancelAtPeriodEnd = false;
  await subscription.save();

  // Downgrade to developer tier
  await syncTierToQuotaService(subscription.orgId, 'developer', '');

  await createBillingEvent(subscription.orgId, 'subscription_canceled', {
    provider: 'stripe',
    previousStatus,
    newStatus: 'canceled',
    externalId,
  }, subscription._id.toString());

  logger.info('Stripe subscription deleted — org downgraded', {
    orgId: subscription.orgId,
    externalId,
  });
}

/**
 * Handle successful invoice payment from Stripe.
 * Confirms the subscription is active, resets grace period state, and updates the billing period.
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  const stripeSubscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id;
  if (!stripeSubscriptionId) {
    logger.debug('Invoice payment_succeeded has no subscription', { invoiceId: invoice.id });
    return;
  }

  const subscription = await findSubscriptionByStripeId(stripeSubscriptionId);
  if (!subscription) {
    logger.warn('No subscription found for successful payment', { stripeSubscriptionId });
    return;
  }

  const previousStatus = subscription.status;
  const wasRecovery = previousStatus === 'past_due';

  // Reset grace period state
  subscription.failedPaymentAttempts = 0;
  subscription.firstFailedAt = undefined;

  // Advance billing period
  subscription.currentPeriodStart = new Date();
  subscription.currentPeriodEnd = calculatePeriodEnd(subscription.currentPeriodStart, subscription.interval);

  // Restore active status if recovering from past_due
  if (wasRecovery) {
    subscription.status = 'active';

    // Re-upgrade to their plan's tier
    const plan = await Plan.findById(subscription.planId);
    if (plan) {
      await syncTierToQuotaService(subscription.orgId, plan.tier, '');
    }
  }

  await subscription.save();

  await createBillingEvent(subscription.orgId, 'payment_succeeded', {
    provider: 'stripe',
    previousStatus,
    newStatus: subscription.status,
    invoiceId: invoice.id,
    stripeSubscriptionId,
    recovered: wasRecovery,
  }, subscription._id.toString());

  logger.info('Stripe payment succeeded', {
    orgId: subscription.orgId,
    stripeSubscriptionId,
    recovered: wasRecovery,
    periodEnd: subscription.currentPeriodEnd.toISOString(),
  });
}

/**
 * Handle failed invoice payment from Stripe.
 * Uses a grace period: the org keeps their tier for PAYMENT_GRACE_PERIOD_DAYS
 * after the first failure. Downgrade only happens when the grace period expires
 * (checked by the subscription lifecycle background job).
 */
async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const stripeSubscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id;
  if (!stripeSubscriptionId) {
    logger.debug('Invoice payment_failed has no subscription', { invoiceId: invoice.id });
    return;
  }

  const subscription = await findSubscriptionByStripeId(stripeSubscriptionId);
  if (!subscription) {
    logger.warn('No subscription found for failed payment', { stripeSubscriptionId });
    return;
  }

  const previousStatus = subscription.status;
  subscription.status = 'past_due';
  subscription.failedPaymentAttempts = (subscription.failedPaymentAttempts || 0) + 1;

  // Record the first failure time (starts the grace period clock)
  if (!subscription.firstFailedAt) {
    subscription.firstFailedAt = new Date();
  }

  await subscription.save();

  // Note: Tier downgrade is NOT immediate — it happens when the grace period
  // expires, checked by startSubscriptionLifecycleChecker() in index.ts.

  await createBillingEvent(subscription.orgId, 'payment_failed', {
    provider: 'stripe',
    previousStatus,
    newStatus: 'past_due',
    invoiceId: invoice.id,
    stripeSubscriptionId,
    failedAttempts: subscription.failedPaymentAttempts,
    gracePeriodDays: config.paymentGracePeriodDays,
  }, subscription._id.toString());

  logger.info('Stripe payment failed — grace period active', {
    orgId: subscription.orgId,
    stripeSubscriptionId,
    failedAttempts: subscription.failedPaymentAttempts,
    firstFailedAt: subscription.firstFailedAt.toISOString(),
    gracePeriodDays: config.paymentGracePeriodDays,
  });
}
