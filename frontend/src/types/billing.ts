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

/** The three shapes an expansion offer can take (`OFFER_TYPES` in billing). */
export type OfferType = 'upgrade' | 'pack' | 'compose';

/**
 * `OFFER_STATUSES` in billing.
 *
 * `suppressed` means NO OFFER WAS MADE (the row records why the rules declined);
 * `withdrawn` means one was made and an operator recalled it. They were briefly
 * the same value, which made "recall what the agent just did" indistinguishable
 * from "the accounts it declined to offer".
 */
export type OfferStatus = 'sent' | 'redeemed' | 'declined' | 'expired' | 'suppressed' | 'withdrawn';

/**
 * ONE expansion offer, as the account's own surface renders it
 * (`GET /billing/offers`, docs/plans/sales-agent.md F4).
 *
 * `subject`/`body` are the copy AS SENT, read back rather than re-rendered: a
 * card that re-derived from today's catalogue would restate last month's offer
 * at this month's price.
 *
 * `rationale` is shown to the account on purpose. "You are at 9 of 10
 * pipelines" is the whole argument, and hiding the signals would make the offer
 * read as a guess rather than as a reading of their own usage.
 */
export interface AccountOffer {
  id: string;
  offerType: OfferType;
  targetTier: QuotaTier | null;
  /**
   * What a `pack`/`compose` offer proposed, so the card can present it as ONE
   * basket (F6) instead of asking the account to assemble the offer itself from
   * the catalogue. Recorded on the offer rather than re-derived, so the basket
   * shown is the basket that was offered.
   */
  targetBundles: Array<{ bundleId: string; quantity: number }>;
  subject: string | null;
  body: string | null;
  rationale: string[];
  status: OfferStatus;
  sentAt: string | null;
  expiresAt: string | null;
  dismissedAt: string | null;
}

/**
 * The account's offer state: the live offer, if any, plus what the settings
 * card needs to explain itself (F7).
 *
 * `quietUntil` is null when nothing is holding the account back. It exists so an
 * account with offers ENABLED and simply inside its quiet period sees that,
 * rather than wondering whether the switch works —  and
 * `offersEnabledOnInstance` so an operator-disabled feature does not look like
 * a broken one.
 */
export interface OfferState {
  offer: AccountOffer | null;
  quietUntil: string | null;
  quietPeriodDays: number;
  offersEnabledOnInstance: boolean;
}

/** One decision row in the system-org offers view (F8). */
export interface AdminOffer extends AccountOffer {
  orgId: string;
  holdout: boolean;
  source: 'agent' | 'manual';
  suppressedReason: string | null;
  holdUntil: string | null;
  cycleKey: string;
  createdAt: string;
}

/**
 * What the agent has been doing (`GET /billing/admin/offers`).
 *
 * The per-reason suppression counts are the headline rather than a detail: a
 * feature suppressing almost everything is misconfigured rather than careful,
 * and that is only visible if every reason is counted separately.
 */
export interface AdminOfferSummary {
  offers: AdminOffer[];
  total: number;
  limit: number;
  offset: number;
  counts: {
    byStatus: Record<string, number>;
    bySuppressionReason: Record<string, number>;
    holdout: number;
  };
  enabled: { billing: boolean; offers: boolean };
  lift: OfferLiftReport;
}

/**
 * The answer to a manual trigger (`POST /billing/admin/offers/trigger/:orgId`).
 *
 * `status` can be `suppressed`, and that is a correct answer rather than a
 * failure: the trigger runs every gate the cycle runs, so an operator asking for
 * an offer learns WHY the rules refused instead of overriding them.
 *
 * Null (not this shape) when the account could not be evaluated at all — no
 * plan, no profile yet — which is deliberately not a suppression.
 */
export interface AdminOfferDecision {
  status: 'sent' | 'suppressed' | OfferStatus;
  reason: string | null;
  offerType: OfferType | null;
  rationale: string[];
  holdout: boolean;
  recorded: boolean;
  delivered: boolean | null;
}

/** One arm of the lift comparison — offered, or holdout. */
export interface OfferLiftArm {
  /** Accounts the cycle has decided on at least once, not rows. */
  accounts: number;
  sent: number;
  /** Accounts that converted — ONE per account, not one per redeemed offer. */
  conversions: number;
  /** Converted accounts ÷ accounts, genuinely 0–1. */
  conversionRate: number;
}

/**
 * Offered against holdout (Phase 6).
 *
 * `lift` can be NEGATIVE, and the UI must show it as computed: a negative lift
 * means the solicited accounts converted LESS than the ones left alone, which is
 * precisely the finding a control group exists to be able to produce. Clamping
 * it would turn the measurement into a claim.
 *
 * Revenue per account is deliberately absent: it needs the price at conversion,
 * which the offer record does not hold, and deriving it from today's catalogue
 * would mis-state the one number the exercise is for.
 */
export interface OfferLiftReport {
  offered: OfferLiftArm;
  holdout: OfferLiftArm;
  lift: number;
  /** Conversions by the SKU actually bought — the targeting check. */
  skuMatch: Record<string, number>;
  timeToConversion: Record<string, number>;
}

/** One row of the do-not-offer list, with the reason that makes it reviewable. */
export interface OfferExclusion {
  orgId: string;
  reason: string;
  actorId: string;
  createdAt: string;
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
    interval: BillingInterval;
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
