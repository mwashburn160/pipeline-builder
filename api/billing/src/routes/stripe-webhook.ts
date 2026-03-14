import {
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  errorMessage,
} from '@mwashburn160/api-core';
import { Router, Request, Response } from 'express';
import type Stripe from 'stripe';
import { createBillingEvent, syncTierToQuotaService } from '../helpers/billing-helpers';
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
 * Handle failed invoice payment from Stripe.
 * Marks the subscription as past_due.
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
  await subscription.save();

  // Look up plan tier to determine if we should downgrade
  const plan = await Plan.findById(subscription.planId);
  if (plan) {
    await syncTierToQuotaService(subscription.orgId, 'developer', '');
  }

  await createBillingEvent(subscription.orgId, 'payment_failed', {
    provider: 'stripe',
    previousStatus,
    newStatus: 'past_due',
    invoiceId: invoice.id,
    stripeSubscriptionId,
  }, subscription._id.toString());

  logger.info('Stripe payment failed — subscription marked past_due', {
    orgId: subscription.orgId,
    stripeSubscriptionId,
  });
}
