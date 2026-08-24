// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  errorMessage,
} from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { createBillingEvent, calculatePeriodEnd, syncEntitlements, MANAGEABLE_SUBSCRIPTION_STATUSES } from '../helpers/billing-helpers.js';
import { applyPlanTierChange, applyTierIncludedAddonPrune } from '../helpers/addon-prune.js';
import type { PrunedAddon } from '../helpers/billing-helpers.js';
import { ingestStripeInvoice, reverseLedgerInvoice } from '../helpers/billing-ledger.js';
import { clearDiscountsOnCancel, reconcileDiscountsOnInvoice } from '../helpers/discount-helpers.js';
import { clawbackRecentPromotions, grantRecurringPromotions, qualifyReferral, recurringPeriodKey } from '../helpers/promotion-engine.js';
import { findSubscriptionByCustomerId, findSubscriptionByStripeId, mapStripeStatus } from '../helpers/stripe-helpers.js';
import { Plan } from '../models/plan.js';
import type { SubscriptionDocument } from '../models/subscription.js';
import { claimWebhookEvent, markWebhookEventDone, releaseWebhookEvent } from '../models/webhook-dedupe.js';
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
        // Reversals: reverse the ledger row + claw back credits granted inside the
        // clawback window (defuses subscribe-grab-refund/chargeback abuse).
        'charge.refunded': (data) => handleChargeRefunded(data as Stripe.Charge),
        'charge.dispute.created': (data) => handleChargeDisputeCreated(data as Stripe.Dispute),
        'invoice.voided': (data) => handleInvoiceReversal(data as Stripe.Invoice, 'invoice_voided'),
        'invoice.marked_uncollectible': (data) => handleInvoiceReversal(data as Stripe.Invoice, 'invoice_uncollectible'),
      };

      // Two-phase idempotency guard (crash-durable): Stripe retries the same
      // event.id on transient failures. Take a SHORT-LIVED in-progress claim
      // before processing — a duplicate/concurrent delivery short-circuits with
      // 200 (so Stripe stops retrying) and skips side-effects. The durable
      // done-marker is written only AFTER the handler succeeds, so a mid-process
      // crash lets the claim expire and Stripe's retry re-runs the event instead
      // of it being stranded as "processed" for 30d.
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
    // Alertable: a Stripe sub exists that backs no org. Without a metric this is
    // a silently-swallowed billing_events row no one watches.
    incCounter('billing_unbound_stripe_subscription_total', { reason: 'no_org_metadata' });
    await createBillingEvent('unknown', 'subscription_created', { unbound: true, externalId });
    return;
  }
  // Provisioning would need plan ID resolution + a primary contact email,
  // which the in-app create flow already handles. Out-of-band creates need
  // operator follow-up — log, meter for alerting, and continue.
  logger.warn('Stripe subscription created out-of-band — operator action required', { externalId, orgId });
  incCounter('billing_unbound_stripe_subscription_total', { reason: 'out_of_band' });
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

  // A `.updated` that crosses OUT of an entitled status into a terminal one
  // (e.g. dunning exhausted → `unpaid`→canceled, or a `.updated`→canceled whose
  // trailing `.deleted` never arrives) must downgrade — otherwise the org keeps
  // its paid tier/seats forever (no lifecycle cron catches a `canceled` row).
  const MANAGEABLE = MANAGEABLE_SUBSCRIPTION_STATUSES as readonly string[];
  const becameUnentitled = MANAGEABLE.includes(previousStatus) && !MANAGEABLE.includes(newStatus);

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
  const oldInterval = subscription.interval;
  let syncedPlan: { tier: QuotaTier } | null = null;
  // Whether the PLAN (tier) actually changed vs. ONLY the billing interval — an
  // interval-only edit records interval_changed, not a plan_changed w/ equal ids.
  let planChanged = false;
  // Bundles dropped because the new tier now includes their feature; their
  // provider line-item removal + audit run AFTER save (via applyPlanTierChange).
  let prunedAddons: PrunedAddon[] = [];
  if (mapped && (mapped.planId !== subscription.planId || mapped.interval !== subscription.interval)) {
    const plan = await Plan.findOne({ _id: mapped.planId, isActive: true });
    if (plan) {
      planChanged = mapped.planId !== oldPlanId;
      subscription.planId = mapped.planId;
      subscription.interval = mapped.interval;
      syncedPlan = plan;
      dirty = true;

      // Prune any PURE-FEATURE add-on the new tier now bundles in (double-billing
      // fix) so a plan change made directly in Stripe also drops the redundant
      // paid bundle. Mutates addons in memory (persisted by the `dirty` save
      // below); hybrid bundles (e.g. `sso`→idpConfigs) are kept.
      prunedAddons = applyTierIncludedAddonPrune(subscription, plan.tier, {
        orgId: subscription.orgId, subscriptionId: subscription._id.toString(), source: 'stripe_plan_change',
      });
    } else {
      logger.warn('Stripe price mapped to an unknown/inactive plan; tier not synced', {
        externalId, mappedPlanId: mapped.planId,
      });
    }
  }

  // Terminal transition: forfeit the local credit mirror before the save (the
  // entitlement downgrade runs post-save below, mirroring handleSubscriptionDeleted).
  if (becameUnentitled) {
    clearDiscountsOnCancel(subscription);
    dirty = true;
  }

  if (dirty) await subscription.save();

  if (becameUnentitled) {
    await syncEntitlements(subscription.orgId, 'developer', '', subscription._id.toString());
    logger.info('Stripe subscription moved to a terminal status via update — org downgraded', {
      orgId: subscription.orgId, externalId, previousStatus, newStatus,
    });
  } else if (syncedPlan) {
    // Shared post-save runner (service-token sync preserving add-ons → change
    // event → pruned line-item removal + addon_pruned trail). System path
    // (webhook) → no actorId. When ONLY the billing interval changed (same plan
    // /tier), record interval_changed instead of a plan_changed with equal ids.
    const runSideEffects = applyPlanTierChange(subscription, syncedPlan, {
      oldPlanId,
      newPlanId: subscription.planId,
      pruned: prunedAddons,
      source: 'stripe_plan_change',
      eventDetails: { provider: 'stripe', source: 'stripe_webhook', interval: subscription.interval },
      event: planChanged ? undefined : {
        type: 'interval_changed',
        details: { provider: 'stripe', source: 'stripe_webhook', oldInterval, newInterval: subscription.interval },
      },
    });
    await runSideEffects();
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
  // Detach any coupon + forfeit the local usage-credit mirror (Stripe balance
  // persists for a future reactivation). Price-only; entitlements handled below.
  clearDiscountsOnCancel(subscription);
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
    } else {
      // planId points at a deleted/missing plan: the sub recovers to an entitled
      // status but we can't resolve a tier to re-grant — without this branch the
      // re-upgrade silently no-ops. Surface it (WARN + audit row + metric) so
      // support can repair the dangling planId. The payment_succeeded row below
      // still records the recovery; this adds the plan-missing signal.
      logger.warn('Payment recovery could not re-upgrade — subscription plan not found', {
        orgId: subscription.orgId, stripeSubscriptionId, planId: subscription.planId,
      });
      await createBillingEvent(subscription.orgId, 'subscription_updated', {
        reason: 'reactivate_plan_missing', provider: 'stripe', planId: subscription.planId,
      }, subscription._id.toString());
      incCounter('billing_reactivate_plan_missing_total', { source: 'stripe_webhook' });
    }
  }

  // Reconcile discounts against this settled invoice (Stripe = source of truth):
  // draw the usage-credit mirror down from the customer balance and re-grant a
  // recurring discount. Price-only; mutates the sub in place before the save below.
  await reconcileDiscountsOnInvoice(subscription, invoice);

  // Re-grant standing RECURRING promotions for the period this invoice opens
  // (period-keyed on the invoice id; in-memory, persisted by the save below).
  // Fail-soft — a promo error must never fail the payment webhook.
  try {
    // Atomic: persist promo credits with guarded $push/$inc, NOT via the full-doc
    // save below — so a concurrent redemption's credit write on the same ledger
    // isn't clobbered (M2). The reconcile above is atomic for the same reason.
    await grantRecurringPromotions(subscription, recurringPeriodKey(subscription.interval), { atomic: true });
  } catch (promoErr) {
    logger.warn('Recurring promotion re-grant failed', { orgId: subscription.orgId, invoiceId: invoice.id, error: String(promoErr) });
  }

  // The credit reconciliation + promo re-grant above wrote atomically and did NOT
  // touch the in-memory doc, so this save() persists only the lifecycle fields this
  // handler set (status / period / grace / metadata) — it can't clobber a
  // concurrent credit-ledger write.
  await subscription.save();

  // Mirror the settled invoice into the billing ledger (dashboard actuals).
  // Idempotent + best-effort — a ledger hiccup must not fail the webhook.
  await ingestStripeInvoice(subscription.orgId, invoice as unknown as Parameters<typeof ingestStripeInvoice>[1]).catch((err) => {
    logger.warn('Billing ledger ingest failed', { orgId: subscription.orgId, invoiceId: invoice.id, error: String(err) });
  });

  await createBillingEvent(subscription.orgId, 'payment_succeeded', {
    provider: 'stripe',
    previousStatus,
    newStatus: subscription.status,
    invoiceId: invoice.id,
    stripeSubscriptionId,
    recovered: wasRecovery,
  }, subscription._id.toString());

  // Referral (phase 2c): a paid invoice is the QUALIFYING event — if this org was
  // referred, credit the referrer now. Idempotent (flips pending→qualified) and
  // fail-soft — never fails the payment webhook.
  try {
    await qualifyReferral(subscription.orgId);
  } catch (refErr) {
    logger.warn('Referral qualification failed', { orgId: subscription.orgId, error: String(refErr) });
  }

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

// Reversals (refund / dispute / void / uncollectible)

/**
 * Recover the invoice/customer id from a Stripe object field that may be a bare
 * id string or an expanded object. Stripe delivers unexpanded ids on webhooks, but
 * a retrieved (expanded) object carries the nested resource.
 */
function idOf(ref: unknown): string | undefined {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && typeof (ref as { id?: unknown }).id === 'string') {
    return (ref as { id: string }).id;
  }
  return undefined;
}

/**
 * Shared reversal tail: claw back promotion credits granted inside the clawback
 * window (the subscribe-grab-refund defense) and record a `subscription_updated`
 * row tagging the reversal reason. `clawbackRecentPromotions` reverses via atomic
 * `$pull`/`$inc` (no `subscription.save()` — a save here would re-add the pulled
 * rows), so this NEVER saves the subscription. Fail-soft: a clawback error must not
 * fail the webhook (the ledger reversal already recorded the money movement).
 */
async function clawbackAndRecordReversal(
  subscription: SubscriptionDocument,
  reason: string,
  details: Record<string, unknown>,
): Promise<void> {
  let clawedPromotions = 0;
  try {
    clawedPromotions = await clawbackRecentPromotions(subscription);
  } catch (err) {
    logger.warn('Promotion clawback failed during reversal', {
      orgId: subscription.orgId, reason, error: errorMessage(err),
    });
  }
  await createBillingEvent(subscription.orgId, 'subscription_updated', {
    provider: 'stripe', reason, clawedPromotions, ...details,
  }, subscription._id.toString());
}

/**
 * Apply a charge-level reversal (refund or dispute): reverse the ledger row for the
 * charge's invoice and claw back recently-granted promotion credits. The
 * subscription is resolved from the charge's CUSTOMER (a Charge/Dispute has no
 * subscription field); the ledger row is reversed by the charge's INVOICE id.
 * Both are independent — a charge with no invoice (non-subscription charge) skips
 * the ledger reversal; a charge with no matched local subscription skips clawback.
 */
async function applyChargeReversal(
  charge: Stripe.Charge,
  ledgerStatus: 'refunded' | 'disputed',
  reason: string,
  netAmountPaidCents: number,
  details: Record<string, unknown>,
): Promise<void> {
  // `invoice` is present on a subscription Charge at runtime but isn't declared on
  // Stripe's Charge type in this SDK version — read it structurally.
  const invoiceId = idOf((charge as { invoice?: unknown }).invoice);
  const customerId = idOf(charge.customer);

  if (invoiceId) {
    await reverseLedgerInvoice(invoiceId, ledgerStatus, netAmountPaidCents);
  }

  const subscription = customerId ? await findSubscriptionByCustomerId(customerId) : null;
  if (!subscription) {
    logger.warn('Charge reversal without a matching local subscription — ledger reversed, no clawback', {
      reason, chargeId: charge.id, invoiceId, customerId,
    });
    return;
  }
  await clawbackAndRecordReversal(subscription, reason, { ...details, invoiceId });
  logger.info('Stripe charge reversal processed', { orgId: subscription.orgId, reason, chargeId: charge.id, invoiceId });
}

/**
 * `charge.refunded` — a (possibly partial) refund settled. Stripe sends the
 * cumulative `amount_refunded` each time, so the net still-paid amount is
 * `amount − amount_refunded` (idempotent absolute).
 */
async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const netPaidCents = Math.max(0, (charge.amount ?? 0) - (charge.amount_refunded ?? 0));
  await applyChargeReversal(charge, 'refunded', 'invoice_refunded', netPaidCents, {
    refundedCents: charge.amount_refunded ?? 0,
    fullyRefunded: charge.refunded === true,
  });
}

/**
 * `charge.dispute.created` — a chargeback opened. The Dispute event carries only
 * the charge id, so we re-fetch the Charge (for its invoice + customer). The
 * disputed funds are withdrawn, so net still-paid = `charge.amount − dispute.amount`.
 */
async function handleChargeDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
  const chargeId = idOf(dispute.charge);
  if (!chargeId) {
    logger.warn('Stripe dispute without a charge id — cannot reverse', { disputeId: dispute.id });
    return;
  }
  const active = getPaymentProvider();
  const stripe = active instanceof StripeProvider ? active.getStripeClient() : null;
  if (!stripe) {
    logger.warn('Stripe client unavailable — cannot resolve disputed charge', { disputeId: dispute.id, chargeId });
    return;
  }
  const charge = await stripe.charges.retrieve(chargeId);
  const netPaidCents = Math.max(0, (charge.amount ?? 0) - (dispute.amount ?? 0));
  await applyChargeReversal(charge, 'disputed', 'invoice_disputed', netPaidCents, {
    disputedCents: dispute.amount ?? 0,
    disputeStatus: dispute.status,
  });
}

/**
 * `invoice.voided` / `invoice.marked_uncollectible` — an invoice reversed at the
 * invoice level. Re-ingest so the ledger row flips to `void`/`uncollectible` via
 * `mapInvoiceStatus` (making those branches live) with the invoice's current
 * amounts, then claw back recently-granted promotion credits.
 */
async function handleInvoiceReversal(invoice: Stripe.Invoice, reason: string): Promise<void> {
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  const subscription = stripeSubscriptionId ? await findSubscriptionByStripeId(stripeSubscriptionId) : null;

  if (subscription) {
    // Re-ingest reflects Stripe's current (void/uncollectible) invoice state onto
    // the row — mapInvoiceStatus maps the status. Best-effort (a ledger hiccup must
    // not fail the webhook / block the clawback).
    await ingestStripeInvoice(subscription.orgId, invoice as unknown as Parameters<typeof ingestStripeInvoice>[1]).catch((err) => {
      logger.warn('Ledger reverse-ingest failed', { orgId: subscription.orgId, invoiceId: invoice.id, reason, error: errorMessage(err) });
    });
    await clawbackAndRecordReversal(subscription, reason, { invoiceId: invoice.id, status: invoice.status });
    logger.info('Stripe invoice reversal processed', { orgId: subscription.orgId, reason, invoiceId: invoice.id });
    return;
  }

  // No local subscription (e.g. an out-of-band invoice): still flip an existing
  // ledger row's status so the dashboard reflects the reversal.
  if (invoice.id) {
    await reverseLedgerInvoice(invoice.id, invoice.status === 'uncollectible' ? 'uncollectible' : 'void', 0);
  }
  logger.warn('Invoice reversal without a matching local subscription', { reason, invoiceId: invoice.id, stripeSubscriptionId });
}

export { handleChargeRefunded, handleChargeDisputeCreated, handleInvoiceReversal };
