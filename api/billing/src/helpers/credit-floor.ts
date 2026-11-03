// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The aggregate credit floor: the minimum share of LIST an invoice must still
 * charge once every reduction has been applied.
 *
 * `BILLING_DISCOUNT_MAX_PERCENT` and `_MAX_CENTS` bound ONE coupon at mint.
 * Nothing bounds the STACK, and that matters because the reductions compose on
 * the same list as additive CREDITS rather than compounding factors — the annual
 * interval (~17%), a volume curve (up to 30%), a combo credit (~30%), a coupon,
 * a standing recurring discount, and a promotion. A scoped coupon takes a second
 * slice of a base a volume curve already discounted, and none of them knows
 * about the others.
 *
 * WHY THIS IS ITS OWN MODULE. The floor used to live in `discount-helpers.ts`,
 * which is also why it only ever saw what that file could see: it counted the
 * combo and volume credits derived from the composition and nothing else. The
 * subscription's own standing recurring discount was invisible to it, and so was
 * every promotion — `discountFloorBreach` appeared ZERO times in
 * `promotion-engine.ts`, so a promotion auto-granted straight through a floor
 * that refused a coupon on the identical account. "Aggregate" meant
 * "combo + volume + the one coupon in front of me".
 *
 * A low-level module fixes the layering that caused it: this file imports only
 * the pure composition pricing, the bundle catalog and config — all of which are
 * themselves leaves — so `promotion-engine` can check the floor without a cycle,
 * and `discount-helpers` can feed it the promotion standing it resolves. Credits that are not derivable from the composition arrive as
 * `standingExtraCents` — one number, so a NEW grant source is added by including
 * it there rather than by discovering, later, that the floor never saw it.
 *
 * The floor is measured against LIST — plan plus add-ons at unit x quantity for
 * the interval — so the annual interval's own ~17% is inside the budget too.
 * That is deliberate: a floor that re-based itself on the annual price would let
 * the stack cut deeper on annual than on monthly, which is backwards.
 */

import { config } from '../config.js';
import { activeComboCredits, discountBaseCents, getComboDiscounts, priceForInterval, volumeCredits } from './combo-pricing.js';
import { snapNetCharge } from './price-rounding.js';
import type { DiscountKind } from './discount-code.js';
import type { BillingInterval, SubscriptionDocument } from '../models/subscription.js';

/** The composition a floor question is asked about. */
export interface FloorComposition {
  planPriceCents: number;
  addons: readonly { bundleId: string; quantity: number }[];
  interval: BillingInterval;
  /**
   * The bundle catalog, injected rather than imported.
   *
   * Keeps this module a true leaf: `billing-helpers` owns the catalog and every
   * caller already holds it, and a static import here would put the floor
   * downstream of the provider/config surface — which, in practice, meant
   * thirteen test suites suddenly had to stub an export they never used.
   */
  bundles: Parameters<typeof activeComboCredits>[1];
  /**
   * Standing credits that are NOT derivable from the composition: the
   * subscription's recurring discount, plus any eligible recurring promotions.
   * Resolved by the caller (see `standingNonDerivedCents`) and passed in, so this
   * module stays a leaf.
   */
  standingExtraCents?: number;
}

/** Where a budget went, for the refusal message and the clamp decision. */
export interface FloorBudget {
  listCents: number;
  /** Everything already standing: derived (combo + volume) + `standingExtraCents`. */
  standingCreditCents: number;
  budgetCents: number;
  /** What a new credit may still add. Never negative. */
  headroomCents: number;
  floorPercent: number;
}

export interface FloorBreach extends FloorBudget {
  proposedCreditCents: number;
}

/**
 * The floor's arithmetic for ONE composition, shared by every question asked of
 * it — "would this redemption breach?", "how much may this period still grant?",
 * "may this promotion grant?" — so the gates cannot disagree about the budget.
 * They did once, which is the whole reason this is one function.
 *
 * `null` = the floor does not apply (disabled, or nothing to measure against).
 */
export function floorBudget(c: FloorComposition): FloorBudget | null {
  const floorPercent = config.discounts.floorPercent;
  // `!(x > 0)` rather than `x <= 0`, which is FALSE for both undefined and NaN —
  // so a missing setting would have fallen through to `100 - undefined` = NaN,
  // and `credits <= NaN` is false, i.e. every redemption reads as a breach. A
  // config value that cannot be read must disable the floor, never refuse
  // silently on behalf of one.
  if (!(floorPercent > 0)) return null;

  // LIST, not what the provider will charge: unit x quantity, before any credit.
  let listCents = c.planPriceCents;
  for (const a of c.addons) {
    const b = c.bundles.find((x) => x.id === a.bundleId);
    if (!b) continue;
    listCents += priceForInterval(b.prices, c.interval) * Math.max(0, Math.trunc(a.quantity));
  }
  if (listCents <= 0) return null;

  // The DERIVED half. Both are pure and are the SAME functions the invoice
  // reconciler grants from, so this cannot disagree with what the customer is
  // actually credited.
  const derived =
    activeComboCredits(c.addons, c.bundles, getComboDiscounts(), c.interval).reduce((n, x) => n + x.creditCents, 0)
    + volumeCredits(c.addons, c.bundles, c.interval).reduce((n, x) => n + x.creditCents, 0);
  const standingCreditCents = derived + Math.max(0, c.standingExtraCents ?? 0);

  const budgetCents = Math.floor((listCents * (100 - floorPercent)) / 100);
  return {
    listCents,
    standingCreditCents,
    budgetCents,
    headroomCents: Math.max(0, budgetCents - standingCreditCents),
    floorPercent,
  };
}

/**
 * The most a DISCRETIONARY credit may add to this composition's period without
 * taking the invoice below the floor — `Infinity` when the floor does not apply
 * (disabled, or a `credit`-kind prepayment, which the floor exempts).
 *
 * Used where a standing credit should SHRINK rather than vanish: the per-period
 * re-grant clamps to this instead of dropping the customer's discount from an
 * invoice with no warning.
 */
export function floorHeadroomCents(c: FloorComposition, kind: DiscountKind): number {
  if (kind === 'credit') return Infinity;
  const budget = floorBudget(c);
  return budget === null ? Infinity : budget.headroomCents;
}

/**
 * The breach when `proposedCreditCents` would push the invoice below the floor,
 * else `null`.
 *
 * REFUSES rather than clamping, where it is used for a redemption: a silent
 * partial credit looks to the customer like the code half-worked, and "this code
 * cannot be combined with the discounts already on this account" is a sentence
 * support can act on. Clamping a redemption would also make the outcome depend
 * on redemption ORDER. The per-period re-grant is the deliberate exception — see
 * {@link floorHeadroomCents}.
 */
export function discountFloorBreach(
  c: FloorComposition,
  proposedCreditCents: number,
  kind: DiscountKind,
): FloorBreach | null {
  if (proposedCreditCents <= 0) return null;
  // A one-time `credit` is a PREPAYMENT, not a price reduction: a goodwill or
  // migration credit is MEANT to exceed one invoice and draw down over several,
  // which is why `creditBalanceCents` banks a remainder and the provider balance
  // outlives the period. Flooring it would refuse a $50 apology on a $39 invoice,
  // and the instrument that bounds it is `maxCents` ($20,000), not this. The floor
  // exists for the reductions that compose against the SAME invoice — `onetime`
  // and `recurring` — and that distinction is why this takes `kind` rather than
  // inferring from `unit`: a recurring DOLLAR discount is still a standing price
  // cut and belongs inside the floor. Promotions have no `credit` kind at all
  // (`onetime` / `recurring` only), so every promotion grant is inside it.
  if (kind === 'credit') return null;

  const budget = floorBudget(c);
  if (budget === null) return null;
  if (budget.standingCreditCents + proposedCreditCents <= budget.budgetCents) return null;
  return { ...budget, proposedCreditCents };
}

/**
 * The standing credit a subscription carries that the COMPOSITION cannot tell
 * you about: its recurring discount. A recurring discount is a standing price
 * cut against every invoice, so leaving it out meant a one-time coupon was
 * measured as though the recurring one did not exist.
 *
 * Recurring PROMOTIONS are the other half and are resolved by the promotion
 * engine (it owns eligibility); callers add the two. Split that way so this
 * module stays low in the graph and `promotion-engine` can use the floor
 * without a cycle.
 */
export function recurringDiscountStandingCents(
  subscription: Pick<SubscriptionDocument, 'recurringDiscount' | 'addons' | 'interval'>,
  planPriceCents: number,
  bundles: Parameters<typeof activeComboCredits>[1],
): number {
  const rd = subscription.recurringDiscount;
  if (!rd) return 0;
  const base = discountBaseCents(rd, planPriceCents, subscription.addons ?? [], bundles, subscription.interval);
  return Math.max(0, creditCents(rd, base));
}

/**
 * Cents a discount rule is worth against `baseCents`: an absolute amount for
 * `dollar`, or the percentage snapped so the NET charge lands on a price-shaped
 * figure for `percent`.
 *
 * Lives here rather than in `discount-helpers` because all three floor gates
 * need it — the coupon redemption, the per-period re-grant and the promotion
 * grant — and `discount-helpers` is downstream of the promotion engine.
 */
export function creditCents(rule: { unit: 'dollar' | 'percent'; value: number }, baseCents: number): number {
  if (rule.unit === 'dollar') return rule.value;
  return snapNetCharge(baseCents, Math.round((baseCents * rule.value) / 100)).creditCents;
}
