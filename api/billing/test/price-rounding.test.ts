// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole-dollar-or-.99 rule, and the one place it deliberately stops.
 *
 * Every amount a customer is CHARGED ends on `.00` or `.99`, rounded UP. The rule
 * exists because none of this catalog's odd cents were authored — $25.18, $90.86
 * and $199.90 were all derived, by the 10x annual convention, by combo prices set
 * as "30% off the basket", and by percentage reductions landing where they land.
 *
 * WHERE IT STOPS: a TOTAL is not snapped. $29.99 + $19.99 = $49.98 and that stays
 * $49.98, because snapping the total would make it disagree with the sum of its
 * own lines — an invoice whose arithmetic does not add up, which is precisely the
 * failure the support size floor was restructured to avoid (it bills a visible
 * top-up LINE rather than a silent minimum on the subtotal). Prices are
 * price-shaped; their sum is just a sum.
 */

import { describe, it, expect } from '@jest/globals';
import { isRoundedPrice, snapUpPrice, snapNetCharge } from '../src/helpers/price-rounding.js';

describe('snapUpPrice', () => {
  it('leaves an exact dollar alone', () => {
    // Snapping $30.00 to $30.99 would be a price RISE, not a rounding.
    for (const v of [100, 3000, 29900, 89900]) expect(snapUpPrice(v)).toBe(v);
  });

  it('leaves a .99 price alone', () => {
    for (const v of [1199, 1999, 2999, 4999, 9999]) expect(snapUpPrice(v)).toBe(v);
  });

  it('lifts the derived annual prices that the 10x convention produced', () => {
    // The largest single class of odd cents in the catalog: 10 x $19.99 = $199.90.
    expect(snapUpPrice(19990)).toBe(19999);
    expect(snapUpPrice(49990)).toBe(49999);
    expect(snapUpPrice(99990)).toBe(99999);
  });

  it('lifts a combo price set as a percentage of its basket', () => {
    expect(snapUpPrice(9086)).toBe(9099); // $90.86 -> $90.99
    expect(snapUpPrice(2518)).toBe(2599); // $25.18 -> $25.99
    expect(snapUpPrice(3492)).toBe(3499); // $34.92 -> $34.99
  });

  it('never moves a price by more than 98 cents', () => {
    for (let c = 0; c < 100; c++) {
      const v = 5000 + c;
      const moved = snapUpPrice(v) - v;
      expect(moved).toBeGreaterThanOrEqual(0);
      expect(moved).toBeLessThanOrEqual(98);
    }
  });

  it('keeps zero free', () => {
    // `listing_pack` is priced at nothing on purpose; $0.99 would make it a paid
    // add-on, and the free Developer tier would stop being free.
    expect(snapUpPrice(0)).toBe(0);
  });

  it('does not invent a price from a non-finite input', () => {
    expect(snapUpPrice(Number.NaN)).toBe(0);
    expect(snapUpPrice(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('always produces a compliant amount', () => {
    for (let v = 0; v <= 2000; v++) expect(isRoundedPrice(snapUpPrice(v))).toBe(true);
  });
});

describe('snapNetCharge', () => {
  it('snaps what is CHARGED and takes the credit as the remainder', () => {
    // 50% of $49.00: the net, not the credit, is what has to look like a price.
    const { netCents, creditCents } = snapNetCharge(4900, 2450);
    expect(netCents).toBe(2499);
    expect(creditCents).toBe(2401);
    // And it reconciles exactly against the line above it on the invoice.
    expect(netCents + creditCents).toBe(4900);
  });

  it('rounds in the vendor\'s favour, so a reduction only ever shrinks', () => {
    for (const [gross, raw] of [[7900, 1185], [4999, 1500], [27995, 8398]] as const) {
      const { creditCents } = snapNetCharge(gross, raw);
      expect(creditCents).toBeLessThanOrEqual(raw);
      expect(raw - creditCents).toBeLessThanOrEqual(98);
    }
  });

  it('clamps a reduction to the line it discounts', () => {
    // A credit larger than what it discounts is a different instrument — a
    // prepayment — and must not arrive through rounding.
    expect(snapNetCharge(4900, 99999)).toEqual({ netCents: 0, creditCents: 4900 });
    expect(snapNetCharge(4900, -500)).toEqual({ netCents: 4900, creditCents: 0 });
  });

  it('leaves a net that is already compliant untouched', () => {
    expect(snapNetCharge(4999, 2000)).toEqual({ netCents: 2999, creditCents: 2000 });
  });
});
