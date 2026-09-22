// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stripe `invoice.*` lifecycle webhook handlers (upcoming / payment_succeeded /
 * payment_failed). Dispatched by routes/stripe-webhook.ts. Provider-driven: no
 * request user, so billing events carry no actorId.
 */

import { createLogger } from '@pipeline-builder/api-core';
import type Stripe from 'stripe';
import { createBillingEvent, calculatePeriodEnd, syncEntitlements, recordReactivatePlanMissing, MANAGEABLE_SUBSCRIPTION_STATUSES } from './billing-helpers.js';
import { ingestStripeInvoice } from './billing-ledger.js';
import { billingPeriodKey } from './billing-period.js';
import { reconcileDiscountsOnInvoice } from './discount-helpers.js';
import { grantRecurringPromotions, qualifyReferral } from './promotion-engine.js';
import { findSubscriptionByStripeId, invoiceSubscriptionId, type StripeEventMeta } from './stripe-helpers.js';
import { acceptStripeEvent, grantOnBecomingEntitled } from './stripe-subscription-handlers.js';
import { config } from '../config.js';
import { Plan } from '../models/plan.js';

const logger = createLogger('billing-stripe-webhook');

/**
 * Handle the `invoice.upcoming` event Stripe sends ~7 days before renewal.
 * Logs a billing event so support staff can see renewal warnings without
 * waiting for the lifecycle cron to run a separate reminder.
 */
export async function handleInvoiceUpcoming(invoice: Stripe.Invoice): Promise<void> {
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
 * Handle successful invoice payment from Stripe.
 * Confirms the subscription is active, resets grace period state, and updates the billing period.
 */
export async function handlePaymentSucceeded(invoice: Stripe.Invoice, event: StripeEventMeta): Promise<void> {
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
  if (!(await acceptStripeEvent(subscription, event, 'invoice.payment_succeeded'))) return;

  const previousStatus = subscription.status;
  // A paid invoice settles the sub whether it was in dunning (`past_due`) or had
  // never settled (`incomplete` — card decline / 3DS / in-app create with no
  // card). Both must come back entitled here: Stripe's `.updated`→active can
  // arrive later or (being unordered) be skipped as older, and an `incomplete`
  // row that stayed so would leave a PAYING org on developer.
  const wasRecovery = previousStatus === 'past_due';
  const wasSettle = previousStatus === 'incomplete';

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
      await recordReactivatePlanMissing(subscription.orgId, subscription._id.toString(), 'stripe_webhook', {
        provider: 'stripe', planId: subscription.planId,
      });
    }
  }

  // First settle out of `incomplete`: go active, consume any stashed referral code,
  // and (post-save, below) grant the tier + the signup promotions the create path
  // withheld — the same grant the `.updated` crossing performs.
  let settleReferralCode: string | undefined;
  if (wasSettle) {
    subscription.status = 'active';
    settleReferralCode = subscription.metadata?.pendingReferralCode as string | undefined;
    if (settleReferralCode) {
      const { pendingReferralCode: _consumed, ...rest } = subscription.metadata ?? {};
      subscription.metadata = rest;
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
    await grantRecurringPromotions(subscription, billingPeriodKey(subscription.interval), { atomic: true });
  } catch (promoErr) {
    logger.warn('Recurring promotion re-grant failed', { orgId: subscription.orgId, invoiceId: invoice.id, error: String(promoErr) });
  }

  // The credit reconciliation + promo re-grant above wrote atomically and did NOT
  // touch the in-memory doc, so this save() persists only the lifecycle fields this
  // handler set (status / period / grace / metadata) — it can't clobber a
  // concurrent credit-ledger write.
  await subscription.save();

  if (wasSettle) {
    await grantOnBecomingEntitled(subscription, null, { previousStatus, referralCode: settleReferralCode });
  }

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
    recovered: wasRecovery || wasSettle,
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
export async function handlePaymentFailed(invoice: Stripe.Invoice, event: StripeEventMeta): Promise<void> {
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
  if (!(await acceptStripeEvent(subscription, event, 'invoice.payment_failed'))) return;

  const previousStatus = subscription.status;

  // Only an ENTITLED sub enters dunning. A late/retried payment_failed for a sub
  // that is already terminal (`canceled` — e.g. delivered after
  // customer.subscription.deleted) or never settled (`incomplete`) must NOT flip it
  // to `past_due`: that status is in the manageable/entitled set, so it would
  // revive a dead subscription (visible, manageable, and re-synced to its paid tier
  // by the drift reconciler) and start a grace clock for nothing.
  if (!(MANAGEABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(previousStatus)) {
    logger.info('Ignoring invoice.payment_failed for a non-entitled subscription — status unchanged', {
      orgId: subscription.orgId, stripeSubscriptionId, status: previousStatus, invoiceId: invoice.id,
    });
    return;
  }

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
