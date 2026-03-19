import type { BillingInterval } from '../models/subscription';

/** Result of creating an external subscription. */
export interface ExternalSubscriptionResult {
  externalId: string;
  externalCustomerId: string;
}

/** Payment provider interface (Stripe, AWS Marketplace, or stub for dev). */
export interface PaymentProvider {
  /** Create a customer in the external payment system. */
  createCustomer(orgId: string, email: string): Promise<string>;

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
}
