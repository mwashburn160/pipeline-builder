// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}
