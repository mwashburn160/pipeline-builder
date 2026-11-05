// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CROSSOVER: an account already paying more in packs than the next tier
 * costs (docs/plans/sales-agent.md, D4).
 *
 * The cheapest defensible expansion offer in the product, and the only one that
 * needs **no discount, no campaign, no model, no profile and no consent beyond
 * what a billing notice already raises** — it is arithmetic over the
 * subscription record. The plan's example: Team plus four seat packs is
 * $278.96 for 7 seats; Business is $249 for 8 of everything.
 *
 * It is INFORMATION rather than solicitation, which is why it ships ahead of the
 * agent and why the frontend can render it without a consent switch. If no
 * account in the install has a crossover, that is worth learning before any of
 * the rest is built.
 *
 * Two things make this honest rather than merely arithmetic:
 *
 *  - **DOMINANCE, not just price.** A cheaper tier that gives less on any
 *    dimension the account actually holds is not a saving, it is a downgrade
 *    wearing a discount. The candidate must match or beat the account's current
 *    EFFECTIVE entitlements — limits and features — before its price is even
 *    compared.
 *  - **The add-ons the move makes redundant are DROPPED from the comparison,
 *    and the ones it does not are kept and still charged.** Comparing a bare
 *    tier price against tier-plus-packs would manufacture a crossover for any
 *    account holding a feature bundle the higher tier does not include.
 *
 * **And the saving is CONDITIONAL, which the verdict says out loud.** A plan
 * change prunes only pure feature bundles the new tier includes; a stackable
 * resource pack survives it and keeps billing. So an account that accepts a
 * crossover and does nothing else pays the new tier PLUS its old packs — more
 * than before. `dropRequiredAddons` and `savingRequiresDrops` carry that, and
 * any surface quoting `savingCents` has to quote them with it.
 */

import { STANDARD_TIERS } from '@pipeline-builder/api-core';
import type { BillingInterval, QuotaTier, QuotaTierLimits } from '@pipeline-builder/api-core';

import { pruneTierIncludedFeatureAddons } from './addon-prune.js';
import { priceForInterval, volumeDiscountPct } from './combo-pricing.js';
import type { BundleConfig, BillingPlanConfig } from '../config/billing-types.js';
import { effectiveEntitlements } from '../config/entitlements.js';

/** An add-on holding, as the subscription records it. */
export interface AddonHolding {
  bundleId: string;
  quantity: number;
}

/** A dimension the candidate tier would REDUCE. Non-empty ⇒ not a crossover. */
export interface Regression {
  dimension: keyof QuotaTierLimits;
  from: number;
  to: number;
}

export interface CrossoverVerdict {
  /** Whether a defensible crossover exists. */
  crossover: boolean;
  tier: QuotaTier;
  interval: BillingInterval;
  /** What the account pays now, per interval: plan + packs, volume discounts applied. */
  currentCents: number;
  /** The tier the account would move to, or null when none dominates for less. */
  candidateTier: QuotaTier | null;
  /** What the candidate costs: its plan price plus any add-on the move cannot retire. */
  candidateCents: number;
  /** `currentCents - candidateCents`. Positive ⇒ the move costs less. */
  savingCents: number;
  /**
   * Add-ons the candidate tier's own entitlements make redundant — what the
   * account should no longer be paying for after the move.
   *
   * SPLIT from `autoPrunedAddons` on purpose, and the distinction is the
   * difference between a true offer and an expensive one: a plan change prunes
   * only PURE FEATURE bundles the new tier includes
   * (`pruneTierIncludedFeatureAddons`). A stackable resource pack — a seat pack,
   * a credits pack — SURVIVES the change and keeps billing on top of the new
   * tier's base. So an account that upgrades and does nothing else pays the new
   * tier PLUS every pack it already held, which is more than before, not less.
   */
  retiredAddons: string[];
  /** The subset the plan change retires by itself, with no further action. */
  autoPrunedAddons: string[];
  /** The subset the ACCOUNT must remove for the saving to be real. */
  dropRequiredAddons: string[];
  /**
   * True when `savingCents` depends on the account removing packs the tier
   * change will not remove for it. The UI must say so — an offer whose saving
   * is conditional, presented as unconditional, leaves the account worse off
   * and is the failure mode D9's pre-flight exists to prevent.
   */
  savingRequiresDrops: boolean;
  /** Add-ons that must be kept (and are still charged) for the move to dominate.
   *  Written inline rather than as `AddonHolding[]` so this body is structurally
   *  identical to the client's copy — which is what makes `wire-type-drift`
   *  police the pair instead of treating them as an invisible name collision. */
  keptAddons: Array<{ bundleId: string; quantity: number }>;
  /** Why no crossover, when there is none. */
  reason?: 'top_tier' | 'no_addons' | 'nothing_cheaper' | 'would_regress';
}

/** `-1` means unlimited and dominates every finite value. */
function dominates(candidate: number, current: number): boolean {
  if (candidate === -1) return true;
  if (current === -1) return false;
  return candidate >= current;
}

/**
 * Per-interval cost of one add-on holding, with its volume curve applied.
 *
 * The curve matters to the comparison rather than being a detail: the seat pack
 * discounts 40% at volume, so an account with many seat packs is cheaper than
 * `unit × qty` suggests — and overstating what they pay now would manufacture a
 * crossover that does not exist.
 */
export function addonCostCents(
  holding: AddonHolding,
  bundles: readonly BundleConfig[],
  interval: BillingInterval,
): number {
  const bundle = bundles.find((b) => b.id === holding.bundleId);
  if (!bundle || holding.quantity <= 0) return 0;
  const qty = bundle.stackable ? holding.quantity : 1;
  const unit = priceForInterval(bundle.prices, interval);
  const gross = unit * qty;
  return Math.round((gross * (100 - volumeDiscountPct(bundle, qty))) / 100);
}

/** Total per-interval spend: plan price plus every held pack. */
export function currentSpendCents(
  plan: BillingPlanConfig,
  addons: readonly AddonHolding[],
  bundles: readonly BundleConfig[],
  interval: BillingInterval,
): number {
  return addons.reduce(
    (sum, h) => sum + addonCostCents(h, bundles, interval),
    priceForInterval(plan.prices, interval),
  );
}

/**
 * Every dimension on which `candidate` gives LESS than `current`.
 *
 * Checked across the full `QuotaTierLimits` surface rather than a curated
 * subset: a dimension nobody thought to list is exactly the one an account
 * silently loses.
 */
export function regressionsAgainst(
  current: Record<keyof QuotaTierLimits, number>,
  candidate: Record<keyof QuotaTierLimits, number>,
): Regression[] {
  const out: Regression[] = [];
  for (const key of Object.keys(current) as (keyof QuotaTierLimits)[]) {
    if (!dominates(candidate[key] ?? 0, current[key] ?? 0)) {
      out.push({ dimension: key, from: current[key] ?? 0, to: candidate[key] ?? 0 });
    }
  }
  return out;
}

/**
 * Which held add-ons a move to `candidateTier` can retire.
 *
 * Greedy and ORDER-STABLE (catalog order), because the answer has to be the
 * same every time it is computed: this figure reaches a customer. Each add-on is
 * dropped only if the account still dominates its current entitlements without
 * it, so a feature bundle the higher tier does not include is kept and stays on
 * the bill.
 */
function partitionAddons(
  candidateTier: QuotaTier,
  addons: readonly AddonHolding[],
  bundles: readonly BundleConfig[],
  currentLimits: Record<keyof QuotaTierLimits, number>,
  currentFeatures: readonly string[],
): { retired: string[]; kept: AddonHolding[] } {
  const order = bundles.map((b) => b.id);
  const sorted = [...addons].sort((a, b) => order.indexOf(a.bundleId) - order.indexOf(b.bundleId));

  let kept = [...sorted];
  const retired: string[] = [];
  for (const holding of sorted) {
    const without = kept.filter((h) => h.bundleId !== holding.bundleId);
    const probe = effectiveEntitlements(candidateTier, without, bundles);
    const keepsFeatures = currentFeatures.every((f) => probe.features.includes(f));
    if (keepsFeatures && regressionsAgainst(currentLimits, probe.limits).length === 0) {
      kept = without;
      retired.push(holding.bundleId);
    }
  }
  return { retired, kept };
}

/**
 * Does this account's spend already argue for a tier move?
 *
 * Scans the standard tiers ABOVE the current one and takes the HIGHEST that both
 * dominates and costs less — highest rather than cheapest, because among moves
 * that all cost less than today, the one with the most headroom is unambiguously
 * the best thing to tell the account about.
 *
 * `unlimited` is never a candidate: it is the billing-disabled default, not a
 * purchasable plan.
 */
export function evaluateCrossover(input: {
  tier: QuotaTier;
  interval: BillingInterval;
  addons: readonly AddonHolding[];
  plans: readonly BillingPlanConfig[];
  bundles: readonly BundleConfig[];
}): CrossoverVerdict {
  const { tier, interval, addons, plans, bundles } = input;
  const planByTier = new Map(plans.map((p) => [p.tier, p]));
  const plan = planByTier.get(tier);

  const base: Pick<CrossoverVerdict, 'tier' | 'interval' | 'currentCents'> = {
    tier,
    interval,
    currentCents: plan ? currentSpendCents(plan, addons, bundles, interval) : 0,
  };
  const none = (reason: CrossoverVerdict['reason']): CrossoverVerdict => ({
    ...base,
    crossover: false,
    candidateTier: null,
    candidateCents: 0,
    savingCents: 0,
    retiredAddons: [],
    autoPrunedAddons: [],
    dropRequiredAddons: [],
    savingRequiresDrops: false,
    keptAddons: [...addons],
    reason,
  });

  if (!plan) return none('nothing_cheaper');
  // No packs means the comparison is tier against tier, which is just a price
  // list — the crossover is specifically about pack spend overtaking a tier.
  if (addons.length === 0) return none('no_addons');

  const ladder = STANDARD_TIERS;
  const here = ladder.indexOf(tier);
  const above = here < 0 ? [] : ladder.slice(here + 1);
  if (above.length === 0) return none('top_tier');

  const current = effectiveEntitlements(tier, addons, bundles);
  let sawRegression = false;

  // Highest first: the best move an account can be told about.
  for (const candidateTier of [...above].reverse()) {
    const candidatePlan = planByTier.get(candidateTier);
    if (!candidatePlan) continue;

    const { retired, kept } = partitionAddons(candidateTier, addons, bundles, current.limits, current.features);
    const after = effectiveEntitlements(candidateTier, kept, bundles);
    const regressions = regressionsAgainst(current.limits, after.limits);
    const keepsFeatures = current.features.every((f) => after.features.includes(f));
    if (regressions.length > 0 || !keepsFeatures) { sawRegression = true; continue; }

    const candidateCents = kept.reduce(
      (sum, h) => sum + addonCostCents(h, bundles, interval),
      priceForInterval(candidatePlan.prices, interval),
    );
    if (candidateCents >= base.currentCents) continue;

    // What the tier change retires BY ITSELF, asked of the same function the
    // change uses, so this cannot drift from the real behaviour.
    const autoPruned = pruneTierIncludedFeatureAddons(addons, candidateTier, bundles)
      .pruned.map((p) => p.bundleId);
    const dropRequired = retired.filter((id) => !autoPruned.includes(id));

    return {
      ...base,
      crossover: true,
      candidateTier,
      candidateCents,
      savingCents: base.currentCents - candidateCents,
      retiredAddons: retired,
      autoPrunedAddons: autoPruned,
      dropRequiredAddons: dropRequired,
      savingRequiresDrops: dropRequired.length > 0,
      keptAddons: kept,
    };
  }

  return none(sawRegression ? 'would_regress' : 'nothing_cheaper');
}
