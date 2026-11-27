// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { incCounter, observe } from '@pipeline-builder/api-server';
import Stripe from 'stripe';
import { isProviderOutcomeUnknown, type DiscountRef, type ExternalSubscriptionResult, type PaymentProvider, type ProviderSubscriptionView } from './payment-provider.js';
// From billing-config, NOT billing-helpers: helpers imports `../config.js`,
// which THROWS without MONGODB_URI when billing is on, so importing the catalog
// through it made this provider — and every suite that loads it — depend on a
// Mongo URI it never uses. billing-config imports api-core and its own types
// only.
import { getBillingConfig } from '../config/billing-config.js';
import type { StripeConfig } from '../config.js';
import { mapStripeStatus } from '../helpers/stripe-helpers.js';
import { stripeSubscriptionPeriod } from '../helpers/stripe-period.js';
import type { BillingInterval } from '../models/subscription.js';

const logger = createLogger('stripe-provider');

/** The Stripe API version every call is made at. */
export const STRIPE_API_VERSION = '2026-10-28.endive';

/**
 * Per-attempt network timeout for every Stripe call. The SDK default is 80s,
 * which is longer than the gateway/client will wait for the billing route — so a
 * hung Stripe connection held the request (and its Mongo state) open long after
 * the caller gave up. 12s, times up to {@link STRIPE_MAX_NETWORK_RETRIES} + 1
 * attempts, still lands inside a typical upstream budget.
 */
export const STRIPE_TIMEOUT_MS = 12_000;

/**
 * Automatic retries on connection errors / 409 / 429 / 5xx. Safe for mutating
 * calls: stripe-node attaches an idempotency key to every retried POST (ours
 * when the caller passed one, a generated `stripe-node-retry-*` key otherwise),
 * so a retry after a lost response replays the original result instead of
 * applying the write twice.
 */
export const STRIPE_MAX_NETWORK_RETRIES = 2;

/** Metric names for every Stripe call this provider makes. */
export const PROVIDER_CALLS_METRIC = 'billing_provider_calls_total';
export const PROVIDER_CALL_DURATION_METRIC = 'billing_provider_call_duration_seconds';

/**
 * Run one Stripe call, metering it as `billing_provider_calls_total{op,outcome}`
 * (outcome `success` | `error` | `unknown`) plus a duration histogram. `unknown`
 * is a timeout / connection loss / 5xx — the write may or may not have applied —
 * and is what a caller must reconcile rather than revert. The error is rethrown
 * unchanged so callers keep inspecting Stripe's own `code`/`type`.
 */
/**
 * Refuse a balance-transaction amount that is not a positive, safe-integer
 * number of cents. The DIRECTION of a balance transaction is chosen by which
 * method is called, so the amount must carry no sign of its own: `Math.abs`
 * used to turn a caller's sign error into the opposite money movement (a
 * negative debit posted a credit). A fractional or NaN amount is a caller bug
 * too, and failing here keeps it from reading as a provider outage.
 */
function assertPositiveCents(cents: number, op: string): void {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error(`${op}: amount must be a positive whole number of cents (got ${String(cents)})`);
  }
}

async function tracked<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let outcome = 'success';
  try {
    return await fn();
  } catch (err) {
    outcome = isProviderOutcomeUnknown(err) ? 'unknown' : 'error';
    throw err;
  } finally {
    incCounter(PROVIDER_CALLS_METRIC, { op, outcome });
    observe(PROVIDER_CALL_DURATION_METRIC, { op }, (Date.now() - startedAt) / 1000);
  }
}

/** The parts of a Stripe webhook endpoint the event-subscription reconcile reads. */
export interface WebhookEndpointView {
  id: string;
  url: string;
  /** `['*']` means every event. */
  enabledEvents: string[];
  livemode: boolean;
  /** False once the endpoint is disabled (by hand, or by Stripe after failed deliveries): it then delivers nothing. */
  enabled: boolean;
}

const toEndpointView = (ep: Stripe.WebhookEndpoint): WebhookEndpointView => ({
  id: ep.id, url: ep.url, enabledEvents: [...ep.enabled_events], livemode: ep.livemode, enabled: ep.status !== 'disabled',
});

/** Stripe statuses in which a subscription is over and cannot be cancelled again. */
const STRIPE_ENDED_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

export class StripeProvider implements PaymentProvider {
  private readonly stripe: Stripe;
  private readonly stripeConfig: StripeConfig;

  constructor(stripeConfig: StripeConfig) {
    this.stripeConfig = stripeConfig;
    // Pinned, not left to the SDK default: the API version decides where fields
    // live (the billing period moved onto subscription items in 2025-03-31), and
    // an SDK upgrade that silently changed it is how the period reads broke. A
    // new SDK fails to compile here until this is reviewed and moved.
    this.stripe = new Stripe(stripeConfig.secretKey, {
      apiVersion: STRIPE_API_VERSION,
      timeout: STRIPE_TIMEOUT_MS,
      maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
    });
  }

  /**
   * Create a Stripe customer for the organization.
   * @returns The Stripe Customer ID (e.g., "cus_xxx")
   */
  async createCustomer(orgId: string, email?: string, idempotencyKey?: string): Promise<string> {
    logger.info('Creating Stripe customer', { orgId });

    const customer = await tracked('customers.create', () => this.stripe.customers.create({
      email: email || undefined,
      metadata: { orgId },
    }, idempotencyKey ? { idempotencyKey } : undefined));

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
    subscriptionRef?: string,
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

    const subscription = await tracked('subscriptions.create', () => this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      // `subscriptionRef` names the local row reserved for this sub: the
      // `customer.subscription.created` webhook can land before that row is
      // bound to the new id, and uses it to tell "still binding" from unbound.
      metadata: { planId, interval, ...(subscriptionRef ? { subscriptionRef } : {}) },
      // Stripe Tax, when the deployment has configured it. Must be set per call:
      // the Dashboard toggle does not reach `subscriptions.create`.
      ...(this.stripeConfig.automaticTax ? { automatic_tax: { enabled: true } } : {}),
    }, idempotencyKey ? { idempotencyKey } : undefined));

    logger.info('Stripe subscription created', {
      customerId,
      subscriptionId: subscription.id,
      status: subscription.status,
    });

    return {
      externalId: subscription.id,
      externalCustomerId: customerId,
      // Surface Stripe's real status so the caller withholds paid entitlements
      // for a subscription that hasn't settled payment yet (lands `incomplete`).
      status: subscription.status,
    };
  }

  /**
   * Create a Stripe Checkout Session (subscription mode) so a brand-new customer
   * can enter a card and start a PAID subscription in one hosted step — the
   * self-serve path `createSubscription` can't provide (it makes a cardless
   * `incomplete` sub). Stripe collects payment, creates the subscription, and
   * fires `customer.subscription.created` carrying the `orgId`/`planId`/`interval`
   * metadata the webhook uses to provision the local row + entitlements. Returns
   * the hosted Checkout URL to redirect the user to.
   */
  async createCheckoutSession(
    customerId: string,
    planId: string,
    interval: BillingInterval,
    opts: { orgId: string; successUrl: string; cancelUrl: string; referralCode?: string },
  ): Promise<string> {
    const priceKey = `${planId}_${interval}`;
    const priceId = this.stripeConfig.priceToPlanMap[priceKey];
    if (!priceId) {
      throw new Error(
        `No Stripe Price ID configured for plan "${planId}" with interval "${interval}". `
        + `Expected key "${priceKey}" in STRIPE_PRICE_MAP.`,
      );
    }
    const metadata: Record<string, string> = { orgId: opts.orgId, planId, interval };
    // Carry the referral/promo code so the webhook can grant signup credit on
    // completion (parity with the in-app create path).
    if (opts.referralCode) metadata.referralCode = opts.referralCode;
    const session = await tracked('checkout.sessions.create', () => this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      // subscription_data.metadata lands on the created Subscription, so the
      // webhook can bind it to the org (metadata.orgId) + resolve the plan.
      subscription_data: { metadata },
      metadata,
      // Same switch as the direct-create path: a Checkout Session created via
      // the API does not inherit the Dashboard's Stripe Tax setting.
      ...(this.stripeConfig.automaticTax ? { automatic_tax: { enabled: true } } : {}),
    }));
    if (!session.url) throw new Error('Stripe Checkout session was created without a URL');
    logger.info('Stripe Checkout session created', { customerId, planId, interval, sessionId: session.id });
    return session.url;
  }

  /**
   * Cancel a Stripe subscription at the end of the current billing period.
   */
  async cancelSubscription(externalId: string): Promise<void> {
    logger.info('Canceling Stripe subscription at period end', { externalId });

    await tracked('subscriptions.cancel_at_period_end', () => this.stripe.subscriptions.update(externalId, {
      cancel_at_period_end: true,
    }));

    logger.info('Stripe subscription marked for cancellation', { externalId });
  }

  /**
   * Cancel a Stripe subscription IMMEDIATELY (not at period end). Used to clean up
   * a DUPLICATE subscription (two checkouts completed for one org) so the customer
   * isn't billed twice — the keeper is the org's existing bound subscription — and
   * by the final org purge. `prorate: false` / `invoice_now: false` are pinned (the
   * API defaults, stated so they cannot drift): no unused-time credit, no final
   * invoice, and so no automatic refund. Cancelling an `incomplete` subscription
   * voids its open first invoice.
   *
   * A refusal on a subscription that is already over at Stripe (`canceled`, or
   * `incomplete_expired` — which `mapStripeStatus` folds into `incomplete`, so a
   * caller reading {@link getSubscription} cannot tell) resolves: there is
   * nothing left to cancel.
   */
  async cancelSubscriptionNow(externalId: string): Promise<void> {
    logger.warn('Canceling Stripe subscription immediately', { externalId });
    try {
      await tracked('subscriptions.cancel', () => this.stripe.subscriptions.cancel(externalId, { prorate: false, invoice_now: false }));
    } catch (err) {
      const current = await tracked('subscriptions.retrieve', () => this.stripe.subscriptions.retrieve(externalId)).catch(() => undefined);
      if (current && STRIPE_ENDED_STATUSES.has(current.status)) {
        logger.info('Stripe subscription already ended — nothing to cancel', { externalId, status: current.status });
        return;
      }
      throw err;
    }
  }

  /**
   * Refund the subscription's first paid invoice in full (see the interface).
   * The invoice names its payment through an InvoicePayment (API 2025-03-31+);
   * the refund is keyed on the invoice id, so a retry or a redelivered webhook
   * cannot refund twice. Throws on a provider failure — the caller counts it.
   */
  async refundFirstPaidInvoice(externalId: string): Promise<{ invoiceId: string; refundId: string } | null> {
    const invoices = await tracked('invoices.list', () => this.stripe.invoices.list({ subscription: externalId, status: 'paid', limit: 100 }));
    // Newest first: the first paid invoice is the last listed.
    const first = invoices.data[invoices.data.length - 1];
    if (!first?.id) return null;
    const payments = await tracked('invoicePayments.list', () => this.stripe.invoicePayments.list({ invoice: first.id, status: 'paid', limit: 1 }));
    const payment = payments.data[0]?.payment;
    const paymentIntent = typeof payment?.payment_intent === 'string' ? payment.payment_intent : payment?.payment_intent?.id;
    const charge = typeof payment?.charge === 'string' ? payment.charge : payment?.charge?.id;
    if (!paymentIntent && !charge) return null;
    const target = paymentIntent ? { payment_intent: paymentIntent } : { charge };
    // Stripe keeps an idempotency key for 24 hours only. A duplicate handled
    // again later (a redelivery, or the paid-after-cancel pass after `.created`
    // already refunded) would otherwise refund a refunded payment — refused by
    // Stripe, and counted as a refund FAILURE that tells an operator to refund
    // by hand. The refund this method made carries the invoice id: reuse it.
    const prior = await tracked('refunds.list', () => this.stripe.refunds.list({ ...target, limit: 100 }));
    const done = prior.data.find((r) => r.metadata?.invoiceId === first.id && r.status !== 'failed' && r.status !== 'canceled');
    if (done) return { invoiceId: first.id, refundId: done.id };
    const refund = await tracked('refunds.create', () => this.stripe.refunds.create(
      { ...target, reason: 'duplicate', metadata: { invoiceId: first.id!, subscriptionId: externalId } },
      { idempotencyKey: `duplicate-subscription-refund-${first.id}` },
    ));
    logger.warn('Refunded a duplicate Stripe subscription\'s first invoice', { externalId, invoiceId: first.id, refundId: refund.id });
    return { invoiceId: first.id, refundId: refund.id };
  }

  /**
   * Update a Stripe subscription to a new plan and/or billing interval.
   * Replaces the existing subscription item with the price for
   * `{planId}_{interval}`. The `interval` is passed in by the caller (the
   * effective post-change cadence) rather than re-derived from the retrieved
   * Stripe metadata — otherwise a monthly→annual change would resolve the OLD
   * cadence's price and never actually re-cadence the customer's billing.
   */
  async updateSubscription(externalId: string, planId: string, interval: BillingInterval): Promise<void> {
    logger.info('Updating Stripe subscription plan', { externalId, planId, interval });

    const subscription = await tracked('subscriptions.retrieve', () => this.stripe.subscriptions.retrieve(externalId));
    const currentItem = subscription.items.data[0];

    if (!currentItem) {
      throw new Error(`Stripe subscription ${externalId} has no items`);
    }

    // Look up the target price via the same `{planId}_{interval}` reverse the
    // webhook + createSubscription use — the caller-supplied interval is
    // authoritative, so plan and cadence changes both land on the right price.
    const priceKey = `${planId}_${interval}`;
    const priceId = this.stripeConfig.priceToPlanMap[priceKey];

    if (!priceId) {
      throw new Error(
        `No Stripe Price ID configured for plan "${planId}" with interval "${interval}".`,
      );
    }

    await tracked('subscriptions.update', () => this.stripe.subscriptions.update(externalId, {
      items: [{ id: currentItem.id, price: priceId }],
      metadata: { planId, interval },
      // Deterministic proration regardless of the Stripe account default (matches
      // syncAddons' explicit behavior) so plan/interval changes bill consistently.
      proration_behavior: 'create_prorations',
    }));

    logger.info('Stripe subscription updated', { externalId, planId, interval, priceId });
  }

  /**
   * Reactivate a Stripe subscription by removing the cancellation.
   */
  async reactivateSubscription(externalId: string): Promise<void> {
    logger.info('Reactivating Stripe subscription', { externalId });

    await tracked('subscriptions.reactivate', () => this.stripe.subscriptions.update(externalId, {
      cancel_at_period_end: false,
    }));

    logger.info('Stripe subscription reactivated', { externalId });
  }

  /**
   * Re-fetch a subscription's current state from Stripe and normalize it. Used
   * by the lifecycle checker to verify a locally-stale 'active' sub: Stripe's
   * status (mapped via `mapStripeStatus` — `canceled`/`unpaid` ⇒ 'canceled')
   * and `current_period_end` are the source of truth for "gone" vs "renewed
   * (late webhook)". A `resource_missing` error means Stripe has no such sub
   * (fully deleted) ⇒ report 'canceled'. Any OTHER error is rethrown so the
   * caller skips the sub this tick rather than false-downgrading on a transient
   * outage.
   */
  async getSubscription(externalId: string): Promise<ProviderSubscriptionView | null> {
    try {
      const sub = await tracked('subscriptions.retrieve', () => this.stripe.subscriptions.retrieve(externalId));
      const period = stripeSubscriptionPeriod(sub);
      return {
        status: mapStripeStatus(sub.status),
        currentPeriodStart: period?.start,
        currentPeriodEnd: period?.end,
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      };
    } catch (err) {
      // Stripe surfaces a fully-deleted subscription as `resource_missing` — the
      // sub is genuinely gone, so report it canceled.
      if ((err as { code?: string })?.code === 'resource_missing') {
        logger.info('Stripe subscription no longer exists — reporting canceled', { externalId });
        return { status: 'canceled' };
      }
      // Transient/unknown error — surface it so the caller does NOT downgrade.
      throw err;
    }
  }

  /**
   * Reconcile add-on line items on the Stripe subscription: keep the base plan
   * item (item[0], created at subscribe time), delete any prior bundle items,
   * and add the current bundles (price `<bundleId>_<interval>` × quantity).
   * Stripe prorates the change. A bundle with no configured price is skipped —
   * silently when the CATALOG price is 0 (deliberately free, so there is nothing
   * to charge), and loudly otherwise, because that is a revenue leak.
   */
  async syncAddons(
    externalId: string,
    addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
    interval: BillingInterval,
  ): Promise<void> {
    const subscription = await tracked('subscriptions.retrieve', () => this.stripe.subscriptions.retrieve(externalId));
    const [baseItem, ...bundleItems] = subscription.items.data;
    if (!baseItem) throw new Error(`Stripe subscription ${externalId} has no items`);

    const items: Stripe.SubscriptionUpdateParams.Item[] = [{ id: baseItem.id }];
    // Remove all previously-added bundle line items (rebuilt below).
    for (const it of bundleItems) items.push({ id: it.id, deleted: true });
    // Add the current bundles.
    for (const { bundleId, quantity } of addons) {
      const priceId = this.stripeConfig.priceToPlanMap[`${bundleId}_${interval}`];
      if (!priceId) {
        // A FREE bundle has no Stripe Price by design — there is nothing to
        // charge, so dropping its line item is correct and not a leak. Without
        // this check every org holding one (listing_pack is free) would increment
        // the revenue-leak counter on every sync and pin the StripeUnmappedBundle
        // alert on forever, which `for: 0m` makes immediate. The rule matches
        // `validateStripe`, which already only demands a Price when price > 0.
        if ((getBillingConfig().bundles.find((b) => b.id === bundleId)?.prices?.[interval] ?? 0) <= 0) continue;
        // Config drift: the add-on is entitled and PRICED but STRIPE_PRICE_MAP has
        // no `<bundleId>_<interval>` price, so the line item is dropped and the
        // customer keeps the entitlement for free. The warn alone only ever showed
        // up in logs; the counter makes the revenue leak alertable, mirroring
        // `billing_marketplace_unmapped_dimension_total` on the Marketplace side.
        logger.warn('No Stripe Price ID for bundle; skipping line item', { bundleId, interval });
        incCounter('billing_stripe_unmapped_bundle_total', { bundle_id: bundleId });
        continue;
      }
      items.push({ price: priceId, quantity });
    }

    await tracked('subscriptions.sync_addons', () => this.stripe.subscriptions.update(externalId, {
      items,
      proration_behavior: 'create_prorations',
    }));
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
      const customer = await tracked('customers.retrieve', () => this.stripe.customers.retrieve(externalCustomerId));
      if (customer.deleted) return false;
      if (customer.invoice_settings?.default_payment_method) return true;
      if (customer.default_source) return true;
      const methods = await tracked('paymentMethods.list', () => this.stripe.paymentMethods.list({ customer: externalCustomerId, limit: 1 }));
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
    const session = await tracked('billingPortal.sessions.create', () => this.stripe.billingPortal.sessions.create({
      customer: externalCustomerId,
      return_url: returnUrl,
    }));
    logger.info('Stripe billing portal session created', { externalCustomerId });
    return session.url;
  }

  /** Stripe realizes usage credits via the customer credit balance. */
  readonly usageCreditSupport = 'balance' as const;

  /**
   * Post a usage credit as a NEGATIVE customer balance transaction — Stripe
   * applies a negative balance to the customer's future invoices until
   * exhausted. This is the single discount mechanism (no coupon objects).
   * `idempotencyKey` dedupes a retried grant.
   */
  async applyUsageCredit(externalCustomerId: string, cents: number, idempotencyKey?: string): Promise<{ ref?: DiscountRef }> {
    assertPositiveCents(cents, 'applyUsageCredit');
    const txn = await tracked('customers.createBalanceTransaction', () => this.stripe.customers.createBalanceTransaction(
      externalCustomerId,
      // The CONFIGURED currency, not a literal: Stripe rejects a balance
      // transaction whose currency differs from the customer's, so a hardcoded
      // 'usd' broke every credit on a non-USD account.
      { amount: -cents, currency: this.stripeConfig.currency },
      idempotencyKey ? { idempotencyKey: `${idempotencyKey}-credit` } : undefined,
    ));
    logger.info('Stripe usage credit applied', { externalCustomerId, cents });
    return { ref: { kind: 'balance', ref: txn.id } };
  }

  /**
   * Take back clawed-back credit as a POSITIVE customer balance transaction —
   * the inverse of {@link applyUsageCredit}. Sized by the caller to the credit
   * still unused, so it removes credit rather than creating a charge.
   */
  async debitUsageCredit(externalCustomerId: string, cents: number, idempotencyKey: string): Promise<{ ref?: DiscountRef }> {
    assertPositiveCents(cents, 'debitUsageCredit');
    const txn = await tracked('customers.createBalanceTransaction', () => this.stripe.customers.createBalanceTransaction(
      externalCustomerId,
      { amount: cents, currency: this.stripeConfig.currency },
      { idempotencyKey: `${idempotencyKey}-debit` },
    ));
    logger.info('Stripe usage credit debited', { externalCustomerId, cents });
    return { ref: { kind: 'balance', ref: txn.id } };
  }

  /**
   * Add a one-off charge to the subscription's NEXT invoice as a pending invoice
   * item: a positive, labelled line (the support size floor's top-up). Attached
   * to the subscription so it lands on that subscription's invoice rather than
   * whichever invoice the customer happens to get next.
   */
  async addInvoiceCharge(
    externalCustomerId: string,
    externalSubscriptionId: string,
    cents: number,
    description: string,
    idempotencyKey: string,
  ): Promise<{ ref: string }> {
    assertPositiveCents(cents, 'addInvoiceCharge');
    const item = await tracked('invoiceItems.create', () => this.stripe.invoiceItems.create(
      {
        customer: externalCustomerId,
        subscription: externalSubscriptionId,
        amount: cents,
        currency: this.stripeConfig.currency,
        description,
      },
      { idempotencyKey: `${idempotencyKey}-charge` },
    ));
    logger.info('Stripe invoice charge added', { externalCustomerId, externalSubscriptionId });
    return { ref: item.id };
  }

  /**
   * Every webhook endpoint on the account. The key decides the Stripe world, so
   * this lists the test-mode endpoints for a test key and the live ones for a
   * live key; each view still carries `livemode` for the caller to check.
   */
  async listWebhookEndpoints(): Promise<WebhookEndpointView[]> {
    const out: WebhookEndpointView[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const page = await tracked('webhookEndpoints.list', () => this.stripe.webhookEndpoints.list(
        startingAfter ? { limit: 100, starting_after: startingAfter } : { limit: 100 },
      ));
      out.push(...page.data.map(toEndpointView));
      if (!page.has_more || page.data.length === 0) return out;
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  /** One webhook endpoint by id (`we_…`). Throws Stripe's `resource_missing` when absent. */
  async retrieveWebhookEndpoint(id: string): Promise<WebhookEndpointView> {
    return toEndpointView(await tracked('webhookEndpoints.retrieve', () => this.stripe.webhookEndpoints.retrieve(id)));
  }

  /**
   * Replace an endpoint's `enabled_events`. Needs a key with WRITE access to
   * Webhook Endpoints (a standard secret key has it; a restricted key must be
   * granted it). The caller passes the full list — this does not merge.
   */
  async updateWebhookEndpointEvents(id: string, events: readonly string[]): Promise<WebhookEndpointView> {
    const ep = await tracked('webhookEndpoints.update', () => this.stripe.webhookEndpoints.update(id, {
      enabled_events: [...events] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
    }));
    logger.info('Stripe webhook endpoint events updated', { endpointId: id, count: events.length });
    return toEndpointView(ep);
  }

  /** Expose the Stripe instance for webhook signature verification. */
  getStripeClient(): Stripe {
    return this.stripe;
  }

  /** Expose the webhook secret for signature verification. */
  getWebhookSecret(): string {
    return this.stripeConfig.webhookSecret;
  }

  /**
   * Which Stripe world this key belongs to, or null when the shape is not
   * recognisable. Test and live are separate worlds with separate signing secrets,
   * so the webhook uses this to refuse an event from the other one — a deployment
   * half-swapped to test credentials otherwise verifies the signature happily and
   * provisions real entitlements from test subscriptions. Restricted keys are
   * `rk_live_` / `rk_test_`, hence the prefix-agnostic match; an unrecognised shape
   * is left unenforced rather than guessed at.
   */
  getKeyMode(): 'live' | 'test' | null {
    const key = this.stripeConfig.secretKey ?? '';
    if (/^[a-z]+_live_/.test(key)) return 'live';
    if (/^[a-z]+_test_/.test(key)) return 'test';
    return null;
  }
}
