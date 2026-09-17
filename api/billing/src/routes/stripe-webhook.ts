// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  errorMessage,
} from '@pipeline-builder/api-core';
import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { handleInvoiceUpcoming, handlePaymentFailed, handlePaymentSucceeded } from '../helpers/stripe-invoice-handlers.js';
import { handleChargeRefunded, handleChargeDisputeCreated, handleInvoiceReversal } from '../helpers/stripe-reversals.js';
import { handleSubscriptionCreated, handleSubscriptionDeleted, handleSubscriptionUpdated } from '../helpers/stripe-subscription-handlers.js';
import { claimWebhookEvent, markWebhookEventDone, releaseWebhookEvent } from '../models/webhook-dedupe.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { StripeProvider } from '../providers/stripe-provider.js';

const logger = createLogger('billing-stripe-webhook');

/** Stripe event type → handler dispatch map (built once at module load). */
const STRIPE_EVENT_HANDLERS: Readonly<Record<string, (data: unknown) => Promise<void>>> = {
  'customer.subscription.created': (data) => handleSubscriptionCreated(data as Stripe.Subscription),
  'customer.subscription.updated': (data) => handleSubscriptionUpdated(data as Stripe.Subscription),
  'customer.subscription.deleted': (data) => handleSubscriptionDeleted(data as Stripe.Subscription),
  'invoice.payment_succeeded': (data) => handlePaymentSucceeded(data as Stripe.Invoice),
  'invoice.payment_failed': (data) => handlePaymentFailed(data as Stripe.Invoice),
  'invoice.upcoming': (data) => handleInvoiceUpcoming(data as Stripe.Invoice),
  // Reversals: reverse the ledger row + claw back credits granted inside the
  // clawback window (defuses subscribe-grab-refund/chargeback abuse).
  'charge.refunded': (data) => handleChargeRefunded(data as Stripe.Charge),
  'charge.dispute.created': (data) => handleChargeDisputeCreated(data as Stripe.Dispute),
  'invoice.voided': (data) => handleInvoiceReversal(data as Stripe.Invoice, 'invoice_voided'),
  'invoice.marked_uncollectible': (data) => handleInvoiceReversal(data as Stripe.Invoice, 'invoice_uncollectible'),
};

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

      // Two-phase idempotency guard (crash-durable): Stripe retries the same
      // event.id on transient failures. Take a SHORT-LIVED in-progress claim
      // before processing — a duplicate/concurrent delivery short-circuits with
      // 200 (so Stripe stops retrying) and skips side-effects. The durable
      // done-marker is written only AFTER the handler succeeds, so a mid-process
      // crash lets the claim expire and Stripe's retry re-runs the event instead
      // of it being stranded as "processed" for 30d.
      const claimToken = await claimWebhookEvent('stripe', event.id);
      if (!claimToken) {
        logger.info('Skipping duplicate Stripe delivery', { eventId: event.id, type: event.type });
        return sendSuccess(res, 200, { received: true, duplicate: true });
      }

      try {
        const handler = STRIPE_EVENT_HANDLERS[event.type];
        if (handler) {
          await handler(event.data.object);
        } else {
          logger.debug('Unhandled Stripe event type', { type: event.type });
        }

        // Side-effects succeeded — promote the in-progress claim to the durable
        // done-marker so retries are deduped (but a crash before this re-runs).
        await markWebhookEventDone('stripe', event.id);
        return sendSuccess(res, 200, { received: true });
      } catch (error) {
        // Release the idempotency claim so Stripe's retry reprocesses this
        // event. The claim is a concurrency lock taken BEFORE processing, not a
        // record of success — leaving it after a failure would make every retry
        // short-circuit as a duplicate and silently drop the event. Best-effort:
        // a failed release is logged but doesn't change the 500 we return.
        try {
          await releaseWebhookEvent('stripe', event.id, claimToken);
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
