// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  errorMessage,
  getServiceAuthHeader,
} from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { createBillingEvent, calculatePeriodEnd, syncEntitlements } from '../helpers/billing-helpers.js';
import { findSubscriptionByStripeId, mapStripeStatus } from '../helpers/stripe-helpers.js';
import { Plan } from '../models/plan.js';
import { claimWebhookEvent, releaseWebhookEvent } from '../models/webhook-dedupe.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { StripeProvider } from '../providers/stripe-provider.js';

const logger = createLogger('billing-stripe-webhook');

/**
 * Reverse the configured `{planId}_{interval}` → Stripe-price-id map to recover
 * the plan + interval a Stripe price belongs to. Used to detect a plan change
 * made directly in Stripe (dashboard/API) from a `customer.subscription.updated`
 * webhook. Returns null for an unknown price (e.g. a bundle price — bundles are
 * reconciled separately) or a malformed map key.
 */
export function planFromStripePrice(priceId: string): { planId: string; interval: 'monthly' | 'annual' } | null {
  for (const [key, id] of Object.entries(config.stripe?.priceToPlanMap ?? {})) {
    if (id !== priceId) continue;
    const idx = key.lastIndexOf('_');
    if (idx <= 0) continue;
    const planId = key.slice(0, idx);
    const interval = key.slice(idx + 1);
    if (interval === 'monthly' || interval === 'annual') return { planId, interval };
  }
  return null;
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
      const active = getPaymentProvider();
      const provider = active instanceof StripeProvider ? active : null;
      if (!provider) {
        return sendError(
          res, 400,
          'Stripe provider is not configured',
          ErrorCode.VALIDATION_ERROR,
        );
      }

      // Without a webhook secret, signature verification is impossible —
      // refuse delivery so Stripe surfaces the misconfiguration via retries
      // rather than us silently processing unsigned payloads.
      if (!provider.getWebhookSecret()) {
        return sendError(
          res, 503,
          'Stripe webhook secret not configured',
          ErrorCode.SERVICE_UNAVAILABLE,
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
        'customer.subscription.created': (data) => handleSubscriptionCreated(data as Stripe.Subscription),
        'customer.subscription.updated': (data) => handleSubscriptionUpdated(data as Stripe.Subscription),
        'customer.subscription.deleted': (data) => handleSubscriptionDeleted(data as Stripe.Subscription),
        'invoice.payment_succeeded': (data) => handlePaymentSucceeded(data as Stripe.Invoice),
        'invoice.payment_failed': (data) => handlePaymentFailed(data as Stripe.Invoice),
        'invoice.upcoming': (data) => handleInvoiceUpcoming(data as Stripe.Invoice),
      };

      // Idempotency guard: Stripe retries the same event.id on transient
      // failures. Claim the ID before processing — duplicate deliveries
      // short-circuit with 200 (so Stripe stops retrying) and skip side-effects.
      const isFirstDelivery = await claimWebhookEvent('stripe', event.id);
      if (!isFirstDelivery) {
        logger.info('Skipping duplicate Stripe delivery', { eventId: event.id, type: event.type });
        return sendSuccess(res, 200, { received: true, duplicate: true });
      }

      try {
        const handler = eventHandlers[event.type];
        if (handler) {
          await handler(event.data.object);
        } else {
          logger.debug('Unhandled Stripe event type', { type: event.type });
        }

        return sendSuccess(res, 200, { received: true });
      } catch (error) {
        // Release the idempotency claim so Stripe's retry reprocesses this
        // event. The claim is a concurrency lock taken BEFORE processing, not a
        // record of success — leaving it after a failure would make every retry
        // short-circuit as a duplicate and silently drop the event. Best-effort:
        // a failed release is logged but doesn't change the 500 we return.
        try {
          await releaseWebhookEvent('stripe', event.id);
        } catch (releaseError) {
          logger.error('Failed to release Stripe webhook idempotency claim after processing error', {
            eventId: event.id,
            error: errorMessage(releaseError),
          });
        }
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
 * stripe 22 (API 2025+) removed the top-level Invoice.subscription field — the
 * subscription now lives under parent.subscription_details. Returns the
 * subscription id, or undefined for a non-subscription invoice.
 */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const sub = invoice.parent?.subscription_details?.subscription;
  return typeof sub === 'string' ? sub : sub?.id;
}

/**
 * Handle a subscription created out-of-band (e.g. directly in the Stripe
 * dashboard or via a non-app checkout flow). Without this, the local DB
 * drifts from Stripe and the org has no Subscription row backing the
 * Stripe customer.
 *
 * If we already have a row matching this Stripe subscription ID we treat it
 * as an update (in-app create + webhook race). Otherwise we log a warning —
 * we don't auto-provision a Subscription row because we'd need to know which
 * orgId to bind it to, and Stripe's `metadata.orgId` is the only safe source.
 */
// NOTE: every createBillingEvent below runs from Stripe's webhook (no request
// user), so actorId is intentionally left undefined — we never fabricate an
// actor for provider-driven events.
async function handleSubscriptionCreated(stripeSubscription: Stripe.Subscription): Promise<void> {
  const externalId = stripeSubscription.id;
  const existing = await findSubscriptionByStripeId(externalId);
  if (existing) {
    return handleSubscriptionUpdated(stripeSubscription);
  }
  const orgId = (stripeSubscription.metadata?.orgId || '').trim();
  if (!orgId) {
    logger.warn('Stripe subscription created without orgId metadata — cannot auto-provision', { externalId });
    await createBillingEvent('unknown', 'subscription_created', { unbound: true, externalId });
    return;
  }
  // Provisioning would need plan ID resolution + a primary contact email,
  // which the in-app create flow already handles. Out-of-band creates need
  // operator follow-up — log and continue.
  logger.warn('Stripe subscription created out-of-band — operator action required', { externalId, orgId });
  await createBillingEvent(orgId, 'subscription_created', { unbound: true, externalId });
}

/**
 * Handle the `invoice.upcoming` event Stripe sends ~7 days before renewal.
 * Logs a billing event so support staff can see renewal warnings without
 * waiting for the lifecycle cron to run a separate reminder.
 */
async function handleInvoiceUpcoming(invoice: Stripe.Invoice): Promise<void> {
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  if (!stripeSubscriptionId) return;

  const subscription = await findSubscriptionByStripeId(stripeSubscriptionId);
  if (!subscription) {
    logger.warn('No subscription found for invoice.upcoming', { stripeSubscriptionId });
    return;
  }

  await createBillingEvent(subscription.orgId, 'subscription_updated', {
    provider: 'stripe',
    eventKind: 'invoice_upcoming',
    invoiceId: invoice.id,
    nextRenewalAt: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null,
    amountDue: invoice.amount_due,
    currency: invoice.currency,
  }, subscription._id.toString());

  logger.info('Stripe invoice.upcoming recorded', {
    orgId: subscription.orgId,
    stripeSubscriptionId,
  });
}

/**
 * Handle subscription updates from Stripe.
 * Syncs status + cancellation state AND plan/interval changes made directly in
 * Stripe (dashboard/API) — the latter recovered by reversing the price map and
 * re-syncing tier entitlements (preserving purchased add-ons).
 */
export async function handleSubscriptionUpdated(stripeSubscription: Stripe.Subscription): Promise<void> {
  const externalId = stripeSubscription.id;
  const subscription = await findSubscriptionByStripeId(externalId);

  if (!subscription) {
    logger.warn('No subscription found for Stripe subscription', { externalId });
    return;
  }

  const previousStatus = subscription.status;
  const newStatus = mapStripeStatus(stripeSubscription.status);
  const cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end ?? false;

  let dirty = false;
  if (newStatus !== subscription.status) {
    subscription.status = newStatus;
    dirty = true;
  }
  if (cancelAtPeriodEnd !== subscription.cancelAtPeriodEnd) {
    subscription.cancelAtPeriodEnd = cancelAtPeriodEnd;
    dirty = true;
  }
  const statusChanged = dirty;

  // Start the grace clock if Stripe moved us into past_due WITHOUT a preceding
  // invoice.payment_failed (which is what normally stamps firstFailedAt).
  // The lifecycle grace cron matches on `firstFailedAt: {$lte: cutoff}`, so a
  // null firstFailedAt would leave the sub stuck in past_due forever and never
  // get downgraded. Stamp `now` here so the clock actually starts. Leave an
  // already-set firstFailedAt untouched (don't reset an in-progress grace
  // window). Not counted in `statusChanged` — this is a clock start, not a
  // customer-visible status transition — but it still marks the row dirty so
  // the stamp persists.
  if (newStatus === 'past_due' && !subscription.firstFailedAt) {
    subscription.firstFailedAt = new Date();
    dirty = true;
  }

  // Plan/interval change made directly in Stripe: the base line item (item[0])
  // carries the plan price; reverse it to the local planId/interval and, if it
  // moved, update the record + re-sync the tier's entitlements (with add-ons).
  const basePriceId = stripeSubscription.items?.data?.[0]?.price?.id;
  const mapped = basePriceId ? planFromStripePrice(basePriceId) : null;
  const oldPlanId = subscription.planId;
  let syncedTier: QuotaTier | null = null;
  if (mapped && (mapped.planId !== subscription.planId || mapped.interval !== subscription.interval)) {
    const plan = await Plan.findOne({ _id: mapped.planId, isActive: true });
    if (plan) {
      subscription.planId = mapped.planId;
      subscription.interval = mapped.interval;
      syncedTier = plan.tier;
      dirty = true;
    } else {
      logger.warn('Stripe price mapped to an unknown/inactive plan; tier not synced', {
        externalId, mappedPlanId: mapped.planId,
      });
    }
  }

  if (dirty) await subscription.save();

  if (syncedTier) {
    // Preserve purchased add-ons: effective caps = tier base + addons.
    const serviceAuth = getServiceAuthHeader({ serviceName: 'billing', orgId: subscription.orgId, role: 'owner' });
    await syncEntitlements(subscription.orgId, syncedTier, serviceAuth, subscription._id.toString(), subscription.addons ?? []);
    await createBillingEvent(subscription.orgId, 'plan_changed', {
      provider: 'stripe', source: 'stripe_webhook', oldPlanId, newPlanId: subscription.planId, interval: subscription.interval,
    }, subscription._id.toString());
    logger.info('Stripe subscription plan synced', {
      orgId: subscription.orgId, externalId, oldPlanId, newPlanId: subscription.planId, interval: subscription.interval,
    });
  }

  if (statusChanged) {
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
  await syncEntitlements(subscription.orgId, 'developer', '', subscription._id.toString());

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
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
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

  // Advance billing period using the invoice line's period so our window
  // tracks Stripe exactly (handles proration, mid-period plan changes,
  // and timezone drift that wall-clock would lose).
  const linePeriod = invoice.lines?.data?.[0]?.period;
  if (linePeriod?.start && linePeriod?.end) {
    subscription.currentPeriodStart = new Date(linePeriod.start * 1000);
    subscription.currentPeriodEnd = new Date(linePeriod.end * 1000);
  } else {
    subscription.currentPeriodStart = new Date();
    subscription.currentPeriodEnd = calculatePeriodEnd(subscription.currentPeriodStart, subscription.interval);
  }

  // Restore active status if recovering from past_due
  if (wasRecovery) {
    subscription.status = 'active';

    // Clear the grace-period downgrade dedupe marker so a FUTURE lapse can
    // re-downgrade (the lifecycle cron excludes rows that still carry it).
    if (subscription.metadata?.gracePeriodDowngradedAt) {
      const { gracePeriodDowngradedAt: _cleared, ...rest } = subscription.metadata;
      subscription.metadata = rest;
    }

    // Re-upgrade to their plan's tier, preserving purchased add-on grants.
    const plan = await Plan.findById(subscription.planId);
    if (plan) {
      await syncEntitlements(subscription.orgId, plan.tier, '', subscription._id.toString(), subscription.addons ?? []);
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
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
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
