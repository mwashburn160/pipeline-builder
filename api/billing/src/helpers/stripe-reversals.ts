// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stripe REVERSAL handling — refunds, disputes, and voided/uncollectible
 * invoices — plus the shared clawback tail they all run.
 *
 * Extracted from `routes/stripe-webhook.ts`, where these sat below the router
 * and were `export`ed at the bottom of the file purely so
 * `test/stripe-reversals.test.ts` could reach them. That made the route file
 * ~870 lines of which the router was ~115, and turned a test seam into part of
 * the route module's public surface. Here the exports are the module's actual
 * API, and the route file goes back to verify → dedupe → dispatch.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type Stripe from 'stripe';
import { createBillingEvent } from './billing-helpers.js';
import { ingestStripeInvoice, reverseLedgerInvoice } from './billing-ledger.js';
import { clawbackRecentPromotions } from './promotion-engine.js';
import { findReversalSubscription, findSubscriptionByStripeId, invoiceSubscriptionId } from './stripe-helpers.js';
import type { SubscriptionDocument } from '../models/subscription.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { StripeProvider } from '../providers/stripe-provider.js';

const logger = createLogger('stripe-reversals');

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

  const { subscription, ambiguous } = customerId
    ? await findReversalSubscription(customerId)
    : { subscription: null, ambiguous: false };
  if (!subscription) {
    if (ambiguous) {
      // Multiple subs share this customer (cancel→resubscribe): the charge can't be
      // attributed to one from the charge alone. Ledger is already reversed (keyed
      // by invoice); skip the sub-scoped clawback so we don't claw the wrong sub's
      // promotions, and flag it for operator review.
      incCounter('billing_charge_reversal_ambiguous_sub_total', { reason });
      logger.warn('Charge reversal: multiple subscriptions for customer — ledger reversed, clawback skipped (ambiguous attribution)', {
        reason, chargeId: charge.id, invoiceId, customerId,
      });
    } else {
      logger.warn('Charge reversal without a matching local subscription — ledger reversed, no clawback', {
        reason, chargeId: charge.id, invoiceId, customerId,
      });
    }
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
export async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
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
export async function handleChargeDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
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
  // Re-fetch the charge (the Dispute event carries only the charge id). If the
  // retrieve fails we RE-THROW: the ledger reversal + promotion clawback (the
  // subscribe-grab-refund fraud defense) are all-or-nothing on this fetch, so
  // swallowing the error and returning 200 would tell Stripe "done" and it would
  // NOT redeliver — permanently skipping the reversal on any transient blip.
  // Throwing lets the dispatcher release the dedupe lease + 500 so Stripe retries
  // over its ~3-day window (disputes are rare; a few retries are fine). The metric
  // surfaces a persistently-failing dispute for operator follow-up.
  let charge: Stripe.Charge;
  try {
    charge = await stripe.charges.retrieve(chargeId);
  } catch (err) {
    incCounter('billing_dispute_retrieve_failed_total', { reason: 'charge_retrieve_error' });
    logger.error('Stripe dispute charge retrieve failed — rethrowing so Stripe redelivers', {
      disputeId: dispute.id, chargeId, error: errorMessage(err),
    });
    throw err;
  }
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
export async function handleInvoiceReversal(invoice: Stripe.Invoice, reason: string): Promise<void> {
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
