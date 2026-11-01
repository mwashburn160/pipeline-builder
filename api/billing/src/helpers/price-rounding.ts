// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One rule for every amount a customer sees: whole dollars, or `.99`.
 *
 * Nothing in the catalog was authored as $25.18 — that figure, and twenty others
 * like it, were DERIVED. Three mechanisms produced them:
 *
 *  - the annual convention. Annual is 10x monthly, so every `.99` monthly price
 *    became a `.90` annual one: $19.99/mo arrived as $199.90/yr.
 *  - combo pricing. A combined price set as "30% off the member basket" lands
 *    wherever the arithmetic lands — $90.86, $34.92, $22.39.
 *  - percentage reductions. A volume curve or a percent coupon takes a share of
 *    a base and leaves whatever remainder it leaves.
 *
 * Each is individually reasonable and collectively they put arbitrary cents on
 * an invoice, which reads as a rounding error rather than a price.
 *
 * ROUNDS UP, never down, and that direction is deliberate twice over: rounding a
 * CHARGE down gives away revenue nobody decided to give away, and rounding a
 * REDUCTION up gives away the same money from the other side. So this snaps the
 * amount being CHARGED upward, and a reduction is then derived as the remainder
 * (see `snapNetCharge`) rather than being rounded on its own — which also means a
 * credit the customer can see on an invoice always reconciles exactly against the
 * line above it.
 *
 * The step is at most 99 cents, so the rule cannot move a price materially; what
 * it removes is the appearance of imprecision.
 */

/** Cents values a price may end on. */
const WHOLE = 0;
const NINETY_NINE = 99;

/** Whether `cents` already satisfies the rule. */
export function isRoundedPrice(cents: number): boolean {
  if (!Number.isFinite(cents)) return false;
  const rem = Math.abs(Math.trunc(cents)) % 100;
  return rem === WHOLE || rem === NINETY_NINE;
}

/**
 * The smallest compliant amount greater than or equal to `cents`.
 *
 * An exact dollar is already compliant and is left alone — snapping $30.00 up to
 * $30.99 would be a price rise, not a rounding. Anything else goes up to the
 * `.99` of its own dollar, which is always at or above the input.
 *
 * Zero stays zero: the free `listing_pack` is priced at nothing on purpose, and
 * $0.99 would make it a paid add-on.
 */
export function snapUpPrice(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  const v = Math.trunc(cents);
  if (v <= 0) return v;
  const rem = v % 100;
  if (rem === WHOLE) return v;
  return v - rem + NINETY_NINE;
}

/**
 * A reduction re-derived so the amount still CHARGED is compliant.
 *
 * Given a line at `grossCents` and a raw reduction of `rawCreditCents`, this
 * snaps the resulting net UP and returns the credit that produces it. The credit
 * therefore shrinks by at most 98 cents, which is the vendor-favourable
 * direction and keeps `gross - credit` reconcilable on the invoice.
 *
 * Clamped so a reduction can never exceed the line or go negative — a credit
 * larger than what it discounts is a different instrument (see the aggregate
 * floor in `discount-helpers`), and must not be smuggled in through rounding.
 */
export function snapNetCharge(grossCents: number, rawCreditCents: number): { netCents: number; creditCents: number } {
  const gross = Math.max(0, Math.trunc(grossCents));
  const raw = Math.min(Math.max(0, Math.trunc(rawCreditCents)), gross);
  const netCents = snapUpPrice(gross - raw);
  return { netCents, creditCents: gross - netCents };
}
