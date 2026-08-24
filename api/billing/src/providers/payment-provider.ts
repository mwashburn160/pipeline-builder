// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { StripeInvoiceLike } from '../helpers/billing-ledger.js';
import type { BillingInterval, SubscriptionStatus } from '../models/subscription.js';

/**
 * Normalized read view of a subscription as the payment provider currently sees
 * it. Returned by {@link PaymentProvider.getSubscription} so provider-agnostic
 * lifecycle code (subscription-lifecycle) can reconcile local state against the
 * provider without knowing provider-specific object shapes.
 */
export interface ProviderSubscriptionView {
  /** The provider's current status, mapped to our internal SubscriptionStatus.
   *  A `canceled` value means the provider considers the subscription gone. */
  status: SubscriptionStatus;
  /** The current period end the provider reports, if it exposes one. A value in
   *  the future for a locally-stale sub signals the provider RENEWED it (a late
   *  webhook) rather than canceled it. */
  currentPeriodEnd?: Date;
  /** Whether the provider has the subscription set to cancel at period end. */
  cancelAtPeriodEnd?: boolean;
}

/** Result of creating an external subscription. */
export interface ExternalSubscriptionResult {
  externalId: string;
  externalCustomerId: string;
  /**
   * The provider's real status for the freshly-created subscription, as a
   * Stripe-style status string (`active`, `trialing`, `incomplete`,
   * `past_due`, …). The caller maps it via `mapStripeStatus` and only grants
   * paid entitlements when it's entitlement-worthy — a subscription created
   * without a settled payment lands `incomplete` and must NOT get paid caps
   * until the later `customer.subscription.updated`→active webhook confirms it.
   */
  status: string;
}

// ─── Discounts (docs/billing-discounts.md) ──────────────────────────

/**
 * How a provider realizes a USAGE CREDIT — the single mechanism every discount
 * kind (onetime/recurring/credit) resolves to. A discount is NOT a provider
 * coupon object; it is a temporary price reduction billing owns, applied as a
 * credit against future charges.
 *   'balance'  — post to the customer's credit balance (Stripe)
 *   'metered'  — withhold reported metered usage (AWS Marketplace)
 *   'none'     — provider can't realize a credit (discounts disallowed)
 */
export type UsageCreditSupport = 'balance' | 'metered' | 'none';

/** A provider-agnostic reference to a realized credit (e.g. a balance txn id). */
export interface DiscountRef {
  kind: 'balance' | 'metered';
  ref: string;
}

/** Payment provider interface (Stripe, AWS Marketplace, or stub for dev). */
export interface PaymentProvider {
  /** Create a customer in the external payment system. `idempotencyKey`, when
   *  supported by the provider, makes a retried create return the original
   *  object instead of minting a duplicate. */
  createCustomer(orgId: string, email?: string, idempotencyKey?: string): Promise<string>;

  /** Create a subscription in the external payment system. `idempotencyKey`,
   *  when supported, dedupes a retried create at the provider. */
  createSubscription(
    customerId: string,
    planId: string,
    interval: BillingInterval,
    idempotencyKey?: string,
  ): Promise<ExternalSubscriptionResult>;

  /** Cancel a subscription in the external payment system. */
  cancelSubscription(externalId: string): Promise<void>;

  /** Update a subscription's plan AND/OR billing interval in the external
   *  payment system. `interval` selects the target price (`{planId}_{interval}`)
   *  so a monthly→annual (or combined plan+interval) change actually re-cadences
   *  the provider's billing instead of silently keeping the old price. */
  updateSubscription(externalId: string, planId: string, interval: BillingInterval): Promise<void>;

  /** Reactivate a canceled subscription. */
  reactivateSubscription(externalId: string): Promise<void>;

  /**
   * Re-fetch a subscription's current state from the provider (the source of
   * truth), normalized to a {@link ProviderSubscriptionView}. Used by the
   * lifecycle checker to verify a locally-stale 'active' sub before downgrading —
   * so a missed cancel webhook is confirmed against the provider, and a merely
   * late renewal webhook is not mistaken for a cancellation. Returns `null` when
   * the provider cannot resolve the subscription in a way that is safe to act on
   * (the caller then leaves the sub untouched for a later tick). Optional:
   * providers whose state is push/notification-driven (marketplace) omit it.
   */
  getSubscription?(externalId: string): Promise<ProviderSubscriptionView | null>;

  /**
   * Reconcile the external subscription's add-on line items to match `addons`
   * (docs/billing-bundles.md §6). Optional — providers without line-item add-ons
   * (marketplace, stub) may no-op. Best-effort: callers apply local entitlements
   * regardless.
   */
  syncAddons?(
    externalId: string,
    addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
    interval: BillingInterval,
  ): Promise<void>;

  /**
   * Whether the customer has a usable payment method on file (so a paid charge
   * can actually settle). Gates paid add-on purchases — especially on the free
   * tier, where an account may have no card yet. Optional: providers that don't
   * manage cards (marketplace, stub) omit it (treated as "no gate").
   */
  hasPaymentMethod?(externalCustomerId: string): Promise<boolean>;

  /**
   * Realize a USAGE CREDIT of `cents` for the customer — the ONE discount
   * mechanism (docs/billing-discounts.md). Every discount kind resolves to a
   * credit billing computes; the provider only posts it (Stripe → negative
   * customer balance). `idempotencyKey` dedupes a retried grant. Returns the
   * provider ref (for reconciliation). Only called when {@link usageCreditSupport}
   * is not `none` and a customer handle exists. There is NO coupon push and NO
   * remove — credits already granted persist; a recurring discount is stopped by
   * clearing its standing rule locally.
   */
  applyUsageCredit?(externalCustomerId: string, cents: number, idempotencyKey?: string): Promise<{ ref?: DiscountRef }>;

  /** How this provider realizes a usage credit. Absent = none. */
  readonly usageCreditSupport?: UsageCreditSupport;

  /**
   * List a customer's historical invoices (newest first) for the billing-ledger
   * BACKFILL — invoices weren't persisted before the ledger existed. Optional:
   * providers without an invoice API (stub, marketplace) omit it.
   */
  listCustomerInvoices?(externalCustomerId: string, limit?: number): Promise<StripeInvoiceLike[]>;

  /**
   * Create a hosted session where the customer can add/update a payment method,
   * returning the URL to redirect them to. Powers the "Add a payment method" CTA
   * after a `PAYMENT_METHOD_REQUIRED` (402). Optional: providers without a hosted
   * portal (marketplace, stub) omit it (the caller returns 501).
   */
  createBillingPortalSession?(externalCustomerId: string, returnUrl: string): Promise<string>;

  /**
   * Create a hosted Checkout session (subscription mode) so a brand-new customer
   * can enter a card and start a PAID subscription in one step, returning the URL
   * to redirect to. Fixes the self-serve dead-end where {@link createSubscription}
   * makes a cardless `incomplete` sub with no card-entry path. The provider must
   * stamp `orgId`/`planId`/`interval` onto the resulting subscription's metadata
   * so the webhook can provision the local row + entitlements on completion.
   * Optional: providers that need no card (stub) or bill externally (marketplace)
   * omit it (the caller falls back to the direct create).
   */
  createCheckoutSession?(
    customerId: string,
    planId: string,
    interval: BillingInterval,
    opts: { orgId: string; successUrl: string; cancelUrl: string },
  ): Promise<string>;
}
