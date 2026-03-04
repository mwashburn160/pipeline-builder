import type { QuotaTier } from './quota-tiers';

/** Billing interval for subscriptions. */
export type BillingInterval = 'monthly' | 'annual';

/** Subscription lifecycle status. */
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete';

/** Payment transaction status. */
export type PaymentStatus = 'succeeded' | 'pending' | 'failed' | 'refunded';

/** Billing event types for audit logging. */
export type BillingEventType =
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_canceled'
  | 'subscription_reactivated'
  | 'plan_changed'
  | 'interval_changed'
  | 'payment_succeeded'
  | 'payment_failed';

/** Price definition for a plan (in cents). */
export interface PlanPrices {
  monthly: number;
  annual: number;
}

/** Plan definition returned by the billing API. */
export interface PlanDefinition {
  id: string;
  name: string;
  description: string;
  tier: QuotaTier;
  prices: PlanPrices;
  features: string[];
  isDefault: boolean;
  sortOrder: number;
}

/** Subscription info returned by the billing API. */
export interface SubscriptionInfo {
  id: string;
  orgId: string;
  planId: string;
  status: SubscriptionStatus;
  interval: BillingInterval;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Billing event info returned by the admin API. */
export interface BillingEventInfo {
  id: string;
  orgId: string;
  subscriptionId?: string;
  type: BillingEventType;
  details: Record<string, unknown>;
  createdAt: string;
}
