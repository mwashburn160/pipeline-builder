// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isGraceDowngraded } from './subscription-status.js';
import { BILLING_CURRENCY } from '../config/currency.js';
import { config } from '../config.js';

/**
 * Where a subscription stands in dunning, so the billing page can say WHEN
 * access ends (or that it already has) instead of a timeless "update your card".
 * Status alone can't: it stays `past_due` after the grace-period downgrade, by
 * design (it is the recovery signal the payment webhook keys on).
 */
export interface SubscriptionDunning {
  /** First failed payment of this lapse (ISO) — the grace clock's start. */
  firstFailedAt: string;
  /** When the grace period ends and the org drops to Developer (ISO). */
  downgradeAt: string;
  /** The downgrade already happened; paying restores the plan. */
  downgraded: boolean;
  /** When it happened (ISO), present only once downgraded. */
  downgradedAt?: string;
}

/** A subscription's applied recurring discount, as the billing UI reads it. */
export interface SubscriptionResponseDiscount {
  discountId: string;
  unit: string;
  value: number;
}

/**
 * The subscription object every billing route returns.
 *
 * Named rather than `Record<string, unknown>`: the builder below fully
 * specifies its output, so an anonymous bag bought nothing and cost the
 * frontend + every caller any check that a field it reads still exists.
 * `planName` / `tier` are optional because they are only present when the
 * caller resolved the plan document.
 */
export interface SubscriptionResponse {
  id: string;
  orgId: string;
  planId: string;
  planName?: string;
  tier?: string;
  status: string;
  interval: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  addons: Array<{ bundleId: string; quantity: number }>;
  recurringDiscount: SubscriptionResponseDiscount | null;
  creditRemainingCents: number;
  /** The currency of a dollar `recurringDiscount.value` and `creditRemainingCents` (lower-case ISO 4217). */
  currency: string;
  /** `null` unless the subscription is in dunning (a failed payment not yet settled). */
  dunning: SubscriptionDunning | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Build a full subscription response object (used in GET, POST, PUT routes).
 */
export function buildSubscriptionResponse(
  subscription: {
    _id: { toString(): string };
    orgId: string;
    planId: string;
    status: string;
    interval: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    addons?: Array<{ bundleId: string; quantity: number }>;
    recurringDiscount?: { discountId: string; unit: string; value: number } | null;
    creditBalanceCents?: number;
    firstFailedAt?: Date | null;
    metadata?: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
  },
  planName?: string,
  tier?: string,
): SubscriptionResponse {
  return {
    id: subscription._id.toString(),
    orgId: subscription.orgId,
    planId: subscription.planId,
    ...(planName !== undefined && { planName }),
    ...(tier !== undefined && { tier }),
    status: subscription.status,
    interval: subscription.interval,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    // Purchased add-on bundles — the billing UI reads these on load.
    addons: (subscription.addons ?? []).map((a) => ({ bundleId: a.bundleId, quantity: a.quantity })),
    // Applied discounts (usage-credit model): the standing recurring rule (if any)
    // and the remaining usage-credit balance the UI renders on the billing page.
    recurringDiscount: subscription.recurringDiscount
      ? { discountId: subscription.recurringDiscount.discountId, unit: subscription.recurringDiscount.unit, value: subscription.recurringDiscount.value }
      : null,
    creditRemainingCents: subscription.creditBalanceCents ?? 0,
    currency: BILLING_CURRENCY,
    dunning: dunningState(subscription),
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}

/** The dunning view of a subscription; `null` outside a lapse. */
function dunningState(subscription: {
  status: string;
  firstFailedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
}): SubscriptionDunning | null {
  if (subscription.status !== 'past_due' || !subscription.firstFailedAt) return null;
  const first = subscription.firstFailedAt;
  const downgradeAt = new Date(first.getTime() + config.paymentGracePeriodDays * 86_400_000);
  const downgraded = isGraceDowngraded(subscription);
  const at = subscription.metadata?.gracePeriodDowngradedAt;
  const downgradedAt = downgraded && (typeof at === 'string' || at instanceof Date) ? new Date(at).toISOString() : undefined;
  return {
    firstFailedAt: first.toISOString(),
    downgradeAt: downgradeAt.toISOString(),
    downgraded,
    ...(downgradedAt ? { downgradedAt } : {}),
  };
}
