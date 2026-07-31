// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace usage-credit realization (active when discounts are enabled —
 * BILLING_DISCOUNTS_ENABLED, the same switch as Stripe).
 *
 * AWS is the merchant of record on Marketplace — there is no customer-balance
 * primitive — so a usage credit is realized by WITHHOLDING reported metered
 * usage: report `units − withheld` for a dimension, where the withheld units'
 * value (at the local list price) is drawn from the account's credit balance.
 * Only whole units can be withheld and the remainder carries to the next cycle,
 * so realization is APPROXIMATE (whole-unit granularity, local price). It only
 * offsets metered charges — never a fixed contract line. See
 * docs/billing-discounts.md.
 */

export interface MeteredDrawdown {
  /** Metered units to WITHHOLD from this cycle's BatchMeterUsage report. */
  withheldUnits: number;
  /** Credit (cents) consumed by the withheld units. */
  creditConsumedCents: number;
  /** Credit (cents) carried forward to the next cycle. */
  remainingCreditCents: number;
}

/**
 * Compute how many metered units to withhold this cycle to draw a usage credit
 * down against a dimension. Withholds whole units the credit can fully cover,
 * bounded by the units actually about to be reported; the unaffordable remainder
 * carries forward. A non-positive credit / price / unit count is a no-op.
 */
export function computeMeteredDrawdown(creditBalanceCents: number, unitPriceCents: number, availableUnits: number): MeteredDrawdown {
  if (creditBalanceCents <= 0 || unitPriceCents <= 0 || availableUnits <= 0) {
    return { withheldUnits: 0, creditConsumedCents: 0, remainingCreditCents: Math.max(0, creditBalanceCents) };
  }
  const affordableUnits = Math.floor(creditBalanceCents / unitPriceCents);
  const withheldUnits = Math.min(affordableUnits, availableUnits);
  const creditConsumedCents = withheldUnits * unitPriceCents;
  return {
    withheldUnits,
    creditConsumedCents,
    remainingCreditCents: creditBalanceCents - creditConsumedCents,
  };
}

/** An add-on's reported quantity after withholding, plus what was withheld. */
export interface DrawdownLine {
  bundleId: string;
  dimension: string;
  /** Quantity to actually report to BatchMeterUsage (original − withheld). */
  reportedQuantity: number;
  withheldUnits: number;
  creditConsumedCents: number;
}

/** The whole-cycle drawdown plan: adjusted add-ons to report + credit consumed. */
export interface MeteredDrawdownPlan {
  /** Add-on set with reported quantities reduced by the withholding. */
  adjustedAddons: Array<{ bundleId: string; quantity: number }>;
  perLine: DrawdownLine[];
  consumedCents: number;
  remainingCents: number;
  /** True when a positive credit balance found no priced/meterable dimension to
   *  draw against — the balance can't be realized this cycle (surface it). */
  unrealizable: boolean;
}

/**
 * Plan one metering cycle's usage-credit drawdown across an account's add-ons.
 * Iterates add-ons in a DETERMINISTIC order (by bundleId), maps each to its
 * metered dimension, and withholds whole units the remaining credit can cover at
 * that dimension's configured per-unit price — threading the shrinking balance to
 * the next dimension. An unmapped or unpriced dimension is reported in FULL (never
 * drawn against). Pure + side-effect-free: the caller reports `adjustedAddons` and,
 * only on a successful report, persists `remainingCents` + a `credit_consumed`
 * event. `unrealizable` flags a nonzero balance that nothing could absorb.
 */
export function planMeteredDrawdown(
  addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
  bundleToDimensionMap: Record<string, string>,
  dimensionPriceMap: Record<string, number>,
  creditBalanceCents: number,
): MeteredDrawdownPlan {
  let remaining = Math.max(0, creditBalanceCents);
  const perLine: DrawdownLine[] = [];
  const adjustedAddons: Array<{ bundleId: string; quantity: number }> = [];
  const ordered = [...addons].sort((a, b) => (a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0));
  for (const addon of ordered) {
    const quantity = Math.max(0, Math.trunc(addon.quantity));
    const dimension = bundleToDimensionMap[addon.bundleId];
    const unitPrice = dimension ? dimensionPriceMap[dimension] : undefined;
    if (!dimension || !unitPrice || unitPrice <= 0 || quantity === 0) {
      adjustedAddons.push({ bundleId: addon.bundleId, quantity });
      continue;
    }
    const draw = computeMeteredDrawdown(remaining, unitPrice, quantity);
    remaining = draw.remainingCreditCents;
    perLine.push({
      bundleId: addon.bundleId,
      dimension,
      reportedQuantity: quantity - draw.withheldUnits,
      withheldUnits: draw.withheldUnits,
      creditConsumedCents: draw.creditConsumedCents,
    });
    adjustedAddons.push({ bundleId: addon.bundleId, quantity: quantity - draw.withheldUnits });
  }

  const consumedCents = Math.max(0, creditBalanceCents) - remaining;
  return {
    adjustedAddons,
    perLine,
    consumedCents,
    remainingCents: remaining,
    // A positive balance that drew NOTHING this cycle is stranded: either no priced
    // meterable dimension is held, or the whole balance is smaller than the cheapest
    // held unit price (a sub-unit remainder whole-unit withholding can't consume).
    // A partial draw (consumed > 0) leaves only the expected approximation residual,
    // which is NOT flagged.
    unrealizable: creditBalanceCents > 0 && consumedCents === 0,
  };
}
