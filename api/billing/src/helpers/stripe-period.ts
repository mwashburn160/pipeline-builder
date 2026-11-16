// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where Stripe reports a subscription's billing period, read the one way.
 *
 * Since Stripe API `2025-03-31` the period lives on each SUBSCRIPTION ITEM
 * (`current_period_start` / `current_period_end`), not on the subscription. Code
 * that still read `subscription.current_period_end` got `undefined` on every
 * call: the late-webhook reconciler could never see a renewal, and a new
 * subscription's period (a trial's included) was guessed from the wall clock.
 *
 * On an invoice, the period that matters is the one the RECURRING charge bills
 * for. Proration lines carry partial periods (the tail of the previous one, from
 * a mid-period change), so taking the first line's period could set a renewed
 * subscription's period to dates that had already passed.
 */

import type Stripe from 'stripe';
import { billingPeriodKey } from './billing-period.js';

/** A billing period: inclusive start, exclusive end. */
export interface BillingWindow {
  start: Date;
  end: Date;
}

const fromUnix = (start: number, end: number): BillingWindow => ({ start: new Date(start * 1000), end: new Date(end * 1000) });

/**
 * The subscription's current period, from its items. With several items the one
 * ending first decides, since that is when the subscription next renews. Null
 * when no item carries a period.
 */
export function stripeSubscriptionPeriod(subscription: Pick<Stripe.Subscription, 'items'>): BillingWindow | null {
  let best: Stripe.SubscriptionItem | undefined;
  for (const item of subscription.items?.data ?? []) {
    if (typeof item.current_period_end !== 'number' || typeof item.current_period_start !== 'number') continue;
    if (!best || item.current_period_end < best.current_period_end) best = item;
  }
  return best ? fromUnix(best.current_period_start, best.current_period_end) : null;
}

/** The invoice-line fields this module reads. */
export interface InvoiceLineLike {
  period?: { start?: number | null; end?: number | null } | null;
  parent?: { subscription_item_details?: { proration?: boolean | null } | null } | null;
}

/**
 * The period an invoice's recurring subscription charge covers: the first
 * subscription line that is not a proration. Null for an invoice with none (a
 * proration-only or one-off invoice), which must not move the subscription's
 * period.
 */
export function recurringInvoicePeriod(invoice: { lines?: { data?: InvoiceLineLike[] } | null }): BillingWindow | null {
  const line = invoice.lines?.data?.find((l) => l.parent?.subscription_item_details?.proration === false);
  const start = line?.period?.start;
  const end = line?.period?.end;
  return start && end ? fromUnix(start, end) : null;
}

/**
 * The credit-period key for a settled invoice: the start of the period its
 * recurring charge opens, else (a proration or one-off) the subscription's
 * current period, so extra invoices in a period share its one grant.
 */
export function invoiceCreditPeriodKey(
  invoice: { lines?: { data?: InvoiceLineLike[] } | null },
  subscription: { currentPeriodStart: Date },
): string {
  return billingPeriodKey(recurringInvoicePeriod(invoice)?.start ?? subscription.currentPeriodStart);
}
