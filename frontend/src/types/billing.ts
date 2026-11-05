// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Plans, subscriptions, add-on bundles, discounts and the usage roll-up they
 *  are billed against. */

import type { BillingInterval, QuotaTier, SubscriptionStatus } from '@pipeline-builder/api-core';

/**
 * Plan definition from the billing API
 */
export interface Plan {
  id: string;
  name: string;
  description: string;
  tier: QuotaTier;
  prices: {
    monthly: number;
    annual: number;
  };
  features: string[];
  isDefault: boolean;
  sortOrder: number;
}

/**
 * Subscription info from the billing API
 */
export interface Subscription {
  id: string;
  orgId: string;
  planId: string;
  planName?: string;
  tier?: QuotaTier;
  status: SubscriptionStatus;
  interval: BillingInterval;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  /** Purchased add-on bundles (docs/billing-bundles.md). */
  addons?: Array<{ bundleId: string; quantity: number }>;
  /** A standing recurring operator discount attached to this subscription (a
   *  per-period usage credit). `null`/absent when none. One-time/credit discounts
   *  aren't stored here — they apply once and show up in Billing History. */
  recurringDiscount?: { discountId: string; value?: number; unit?: 'dollar' | 'percent'; kind?: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** An operator-granted discount record (docs/billing-discounts.md). Price-only —
 *  never changes quotas/tier. `value` is percent-points when `unit==='percent'`,
 *  else whole cents. Tokens are issued separately and never returned here. */
export interface Discount {
  id: string;
  value: number;
  unit: 'dollar' | 'percent';
  kind: 'onetime' | 'recurring' | 'credit';
  campaign?: string;
  alias?: string;
  targetOrgId?: string;
  maxRedemptions?: number;
  timesRedeemed: number;
  redeemBy?: string;
  appliesToTiers?: string[];
  appliesToBundles?: string[];
  isActive: boolean;
  /**
   * DERIVED by the API, not stored — `isActive` alone says none of it. Nothing
   * sweeps `redeemBy` (redemption checks it instead), so an expired code keeps
   * `isActive: true` for ever, and an exhausted one does too. `redeemable` is
   * the single answer to "would a redemption succeed right now?".
   */
  expired?: boolean;
  exhausted?: boolean;
  redeemable?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A discount CAMPAIGN: the identity a set of codes belongs to, carrying the
 * shared budget, the redemption window and the one-per-account rule that cannot
 * be expressed on an individual code. A promotion can reference one too, so a
 * campaign caps both instruments.
 */
export interface Campaign {
  /** The normalized slug — also what a discount's / promotion's `campaign` holds. */
  id: string;
  name: string;
  /** Total cents the campaign may give away; `undefined` = unlimited. */
  budgetCents?: number;
  spentCents: number;
  /** `null` when the budget is unlimited (nothing to remain). */
  remainingCents: number | null;
  grantsCount: number;
  /** One redemption per account across every code in the campaign. */
  exclusive?: boolean;
  startsAt?: string;
  endsAt?: string;
  isActive: boolean;
  /** Derived, for the same reason a discount's are. */
  started?: boolean;
  ended?: boolean;
  budgetExhausted?: boolean;
  open?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** A purchasable add-on bundle (expansion revenue). */
export interface Bundle {
  id: string;
  name: string;
  description: string;
  grants: Record<string, number>;
  features?: string[];
  prices: { monthly: number; annual: number };
  stackable: boolean;
  /** Optional per-unit volume discount tiers (e.g. the per-seat `seat` bundle):
   *  at ≥ minQuantity units, discountPercent comes off the line. Highest wins. */
  volumeTiers?: { minQuantity: number; discountPercent: number }[];
  maxQuantity?: number;
  availableForTiers: QuotaTier[];
  /** Prerequisite bundle ids that must be held first (e.g. Advanced → Standard Compliance). */
  requires?: string[];
  /** Prerequisite feature flags the plan or a held add-on must provide. */
  requiresFeatures?: string[];
  /** Set by `GET /billing/bundles` when the account doesn't meet a prerequisite
   *  yet — the same gate the add route 400s on, so the card can explain it. */
  unmetRequirement?: { bundleIds: string[]; features: string[]; message: string };
}

/** A combo discount advertised in the bundle catalog: owning every member bundle
 *  bills the set at a reduced combined price (realized as a recurring usage
 *  credit). `savings` is the per-interval reduction vs buying the members apart. */
export interface ComboDiscount {
  id: string;
  name: string;
  bundleIds: string[];
  /** Per-member minimum quantity (bundleId → count; absent ⇒ 1). */
  minQuantities?: Record<string, number>;
  savings: { monthly: number; annual: number };
}

/** A combo discount gained or lost by a proposed add-on change. */
export interface ComboChange {
  comboId: string;
  name: string;
  creditCents: number;
}

/**
 * An itemized price line + total.
 *
 * Returned by the add-on preview/mutation AND by `GET /billing/charges`, which
 * is the STANDING view of the same shape — what the account pays right now
 * rather than what a proposed change would cost. The two share the type because
 * they are the same arithmetic; only the add-on set differs (held vs proposed).
 */
/**
 * Does this account's pack spend already argue for a tier move?
 * (`GET /billing/crossover`.)
 *
 * MIRRORS `api/billing/src/helpers/crossover.ts` `CrossoverVerdict` — the
 * client cannot import it (the billing service is not a browser dependency), so
 * `wire-type-drift` holds the two shapes identical.
 *
 * `crossover: false` always carries a `reason`, because the UI has to stay
 * silent for the right cause: "no packs held" is a normal state, while
 * "would_regress" means a cheaper tier exists that would cost the account
 * capacity, and neither should render as an offer.
 */
export interface CrossoverVerdict {
  crossover: boolean;
  tier: QuotaTier;
  interval: BillingInterval;
  /** What the account pays now, per interval: plan + packs, volume discounts applied. */
  currentCents: number;
  candidateTier: QuotaTier | null;
  /** The candidate's plan price plus any add-on the move cannot retire. */
  candidateCents: number;
  /** `currentCents - candidateCents`. Positive ⇒ the move costs less. */
  savingCents: number;
  retiredAddons: string[];
  /** The subset the plan change retires by itself (pure feature bundles). */
  autoPrunedAddons: string[];
  /** The subset the ACCOUNT must remove for the saving to be real. */
  dropRequiredAddons: string[];
  /**
   * True when `savingCents` depends on the account removing packs the tier
   * change will NOT remove for it — a resource pack survives a plan change and
   * keeps billing on top of the new tier's base. Any surface quoting the saving
   * must quote this with it, or the account upgrades, keeps the packs, and pays
   * more than before.
   */
  savingRequiresDrops: boolean;
  keptAddons: Array<{ bundleId: string; quantity: number }>;
  reason?: 'top_tier' | 'no_addons' | 'nothing_cheaper' | 'would_regress';
}

/**
 * What a plan change lands on, priced by the server (`GET /billing/plan-preview`).
 *
 * `netPlanCents` is the plan line after the standing discount; `totalCents`
 * adds the add-ons the move does NOT retire, which is the figure the next
 * invoice carries. Quoting `listCents` alone is the bug F1 exists to fix.
 */
export interface PlanChangePreview {
  tier: QuotaTier;
  fromTier: QuotaTier;
  interval: BillingInterval;
  listCents: number;
  discountCents: number;
  netPlanCents: number;
  survivingAddonCents: number;
  prunedAddons: string[];
  totalCents: number;
  discountName: string | null;
}

export interface AddonPriceBreakdown {
  interval: string;
  items: Array<{ label: string; quantity: number; cents: number }>;
  totalCents: number;
}

/** Result of an add-on add/remove/preview: effective limits + itemized price. */
export interface AddonResult {
  addons: Array<{ bundleId: string; quantity: number }>;
  effectiveLimits: Record<string, number>;
  priceBreakdown: AddonPriceBreakdown;
  subscription?: Subscription;
  /** Combo discounts this change would end / unlock (drives the removal warning). */
  lostCombos?: ComboChange[];
  gainedCombos?: ComboChange[];
}

/**
 * Billing event from the admin API
 */
export interface BillingEvent {
  id: string;
  orgId: string;
  subscriptionId?: string;
  type: string;
  details: Record<string, unknown>;
  createdAt: string;
}

/**
 * Per-quota row in the cost+usage rollup. `remaining` and
 * `percentOfLimit` are null when the quota is unlimited (limit === -1) so
 * the UI knows to render an em-dash instead of a misleading progress bar.
 */
export interface UsageEntry {
  used: number;
  limit: number;
  remaining: number | null;
  percentOfLimit: number | null;
  resetAt: string;
}

/**
 * Pooled seat usage for the account (root). `limit === -1` means unlimited.
 * Sourced from platform (seats aren't a quota type), so it's `null` on the
 * rollup when that read fails — the rest of the usage view still renders.
 */
export interface SeatUsage {
  used: number;
  limit: number;
}

/** Response shape of `GET /api/billing/usage` (cost attribution surface). */
export interface UsageRollup {
  period: {
    start: string;
    end: string;
    daysElapsed: number;
    daysRemaining: number;
  };
  subscription: {
    planId: string;
    planName: string;
    tier: QuotaTier;
    interval: 'monthly' | 'annual';
    priceCents: number;
  } | null;
  usage: Record<string, UsageEntry>;
  /** Pooled seat usage for the account. `null` when the platform read failed. */
  seats: SeatUsage | null;
  cost: {
    subscriptionCents: number;
    /** Upper-case ISO code, from the server's `BILLING_CURRENCY`. NOT the literal
     *  'USD' any more: prices are authored in one currency, and a deployment
     *  billing in another was mislabelled on every amount. Kept in step with
     *  api/billing usage-helpers by frontend/test/wire-type-drift.test.ts. */
    currency: string;
  };
}
