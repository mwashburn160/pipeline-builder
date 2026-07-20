// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
   * Create a hosted session where the customer can add/update a payment method,
   * returning the URL to redirect them to. Powers the "Add a payment method" CTA
   * after a `PAYMENT_METHOD_REQUIRED` (402). Optional: providers without a hosted
   * portal (marketplace, stub) omit it (the caller returns 501).
   */
  createBillingPortalSession?(externalCustomerId: string, returnUrl: string): Promise<string>;
}
