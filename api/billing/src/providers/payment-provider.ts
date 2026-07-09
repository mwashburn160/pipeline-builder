// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BillingInterval } from '../models/subscription.js';

/** Result of creating an external subscription. */
export interface ExternalSubscriptionResult {
  externalId: string;
  externalCustomerId: string;
}

/** Payment provider interface (Stripe, AWS Marketplace, or stub for dev). */
export interface PaymentProvider {
  /** Create a customer in the external payment system. */
  createCustomer(orgId: string, email?: string): Promise<string>;

  /** Create a subscription in the external payment system. */
  createSubscription(
    customerId: string,
    planId: string,
    interval: BillingInterval,
  ): Promise<ExternalSubscriptionResult>;

  /** Cancel a subscription in the external payment system. */
  cancelSubscription(externalId: string): Promise<void>;

  /** Update a subscription's plan in the external payment system. */
  updateSubscription(externalId: string, planId: string): Promise<void>;

  /** Reactivate a canceled subscription. */
  reactivateSubscription(externalId: string): Promise<void>;

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
