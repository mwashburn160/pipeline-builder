// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Marketplace metered usage-credit drawdown, opt-in.
 * Pure — no mocks.
 */

import { describe, it, expect } from '@jest/globals';
import { prng } from './helpers/prng.js';
import { computeMeteredDrawdown, planMeteredDrawdown } from '../src/helpers/marketplace-credit.js';

describe('computeMeteredDrawdown', () => {
  it('withholds whole units the credit can cover', () => {
    // $30 credit, $10/unit, 5 units reported → withhold 3, consume $30, none left.
    expect(computeMeteredDrawdown(3000, 1000, 5)).toEqual({ withheldUnits: 3, creditConsumedCents: 3000, remainingCreditCents: 0 });
  });

  it('is bounded by the units actually reported (carries the rest forward)', () => {
    // $30 credit covers 3 units, but only 2 are being reported → withhold 2, carry $10.
    expect(computeMeteredDrawdown(3000, 1000, 2)).toEqual({ withheldUnits: 2, creditConsumedCents: 2000, remainingCreditCents: 1000 });
  });

  it('withholds only whole units — a partial unit carries forward', () => {
    // $25 credit at $10/unit → 2 whole units, $5 carries.
    expect(computeMeteredDrawdown(2500, 1000, 10)).toEqual({ withheldUnits: 2, creditConsumedCents: 2000, remainingCreditCents: 500 });
  });

  it('is a no-op for non-positive credit, price, or units', () => {
    expect(computeMeteredDrawdown(0, 1000, 5)).toEqual({ withheldUnits: 0, creditConsumedCents: 0, remainingCreditCents: 0 });
    expect(computeMeteredDrawdown(3000, 0, 5)).toMatchObject({ withheldUnits: 0, remainingCreditCents: 3000 });
    expect(computeMeteredDrawdown(3000, 1000, 0)).toMatchObject({ withheldUnits: 0, remainingCreditCents: 3000 });
  });
});

describe('planMeteredDrawdown', () => {
  const dimMap = { seat_pack: 'seats', pipeline_pack: 'pipelines', plugin_pack: 'plugins' };
  const priceMap = { seats: 1000, pipelines: 500 }; // plugins deliberately unpriced

  it('threads the shrinking balance across dimensions in deterministic (bundleId) order', () => {
    // $35 credit. Order: pipeline_pack(500×4), plugin_pack(unpriced), seat_pack(1000×3).
    // pipelines: withhold 4 → $20 consumed, $15 left. seats: $15 covers 1 unit → withhold 1, $5 left.
    const plan = planMeteredDrawdown(
      [{ bundleId: 'seat_pack', quantity: 3 }, { bundleId: 'plugin_pack', quantity: 9 }, { bundleId: 'pipeline_pack', quantity: 4 }],
      dimMap, priceMap, 3500,
    );
    expect(plan.consumedCents).toBe(3000); // pipelines 4×$5=$20 + seats 1×$10=$10
    expect(plan.remainingCents).toBe(500);
    expect(plan.adjustedAddons).toEqual([
      { bundleId: 'pipeline_pack', quantity: 0 }, // 4 − 4 withheld
      { bundleId: 'plugin_pack', quantity: 9 }, // unpriced → full
      { bundleId: 'seat_pack', quantity: 2 }, // 3 − 1 withheld
    ]);
    expect(plan.unrealizable).toBe(false);
  });

  it('reports an unpriced / unmapped dimension in full and never draws against it', () => {
    const plan = planMeteredDrawdown([{ bundleId: 'plugin_pack', quantity: 5 }], dimMap, priceMap, 5000);
    expect(plan.consumedCents).toBe(0);
    expect(plan.adjustedAddons).toEqual([{ bundleId: 'plugin_pack', quantity: 5 }]);
    expect(plan.unrealizable).toBe(true); // credit but nothing priced to draw against
  });

  it('flags a sub-unit balance as unrealizable (whole-unit withholding can never draw it)', () => {
    const plan = planMeteredDrawdown([{ bundleId: 'seat_pack', quantity: 2 }], dimMap, priceMap, 500); // $5 < $10/unit
    expect(plan).toMatchObject({ consumedCents: 0, remainingCents: 500, unrealizable: true });
    expect(plan.adjustedAddons).toEqual([{ bundleId: 'seat_pack', quantity: 2 }]);
  });

  it('is a no-op with zero balance (not unrealizable)', () => {
    const plan = planMeteredDrawdown([{ bundleId: 'seat_pack', quantity: 2 }], dimMap, priceMap, 0);
    expect(plan).toMatchObject({ consumedCents: 0, remainingCents: 0, unrealizable: false });
  });
});

// A price that is not a positive whole number of cents cannot value a withheld
// unit: 2.5 drew fractional cents into the balance (`creditBalanceCents` stops
// being an integer and every later comparison against it is float arithmetic),
// and a NaN or string entry from a hand-edited env map coerced its way in.
describe('planMeteredDrawdown — malformed dimension prices', () => {
  const dimMap = { seat_pack: 'seats' };

  it.each([
    ['fractional', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['numeric string', '250' as unknown as number],
    ['negative', -100],
  ])('treats a %s price as unpriced (reported in full, nothing drawn)', (_label, price) => {
    const plan = planMeteredDrawdown([{ bundleId: 'seat_pack', quantity: 4 }], dimMap, { seats: price }, 1001);
    expect(plan.consumedCents).toBe(0);
    expect(plan.remainingCents).toBe(1001);
    expect(plan.adjustedAddons).toEqual([{ bundleId: 'seat_pack', quantity: 4 }]);
  });
});

// INVARIANTS, over seeded random compositions: the drawdown never spends credit
// the balance does not hold, every amount stays an integer number of cents, the
// credit consumed is exactly what the withheld units are worth, and consumed +
// remaining reconciles to the starting balance.
describe('planMeteredDrawdown — money invariants (seeded property test)', () => {
  const dims = ['a', 'b', 'c', 'd'];
  const dimMap = Object.fromEntries(dims.map((d) => [`${d}_pack`, d]));

  it('never overdraws, stays in whole cents, and reconciles consumed + remaining = balance', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = prng(seed);
      const priceMap = Object.fromEntries(dims.map((d) => [d, r.int(0, 3) === 0 ? 0 : r.int(1, 5000)]));
      const addons = dims.filter(() => r.int(0, 1) === 1).map((d) => ({ bundleId: `${d}_pack`, quantity: r.int(0, 50) }));
      const balance = r.int(-500, 200_000);
      const plan = planMeteredDrawdown(addons, dimMap, priceMap, balance);
      const ctx = `seed=${seed}`;
      expect({ ctx, ok: plan.consumedCents >= 0 && plan.remainingCents >= 0 }).toEqual({ ctx, ok: true });
      expect({ ctx, sum: plan.consumedCents + plan.remainingCents }).toEqual({ ctx, sum: Math.max(0, balance) });
      expect({ ctx, int: Number.isSafeInteger(plan.consumedCents) && Number.isSafeInteger(plan.remainingCents) }).toEqual({ ctx, int: true });
      const worth = plan.perLine.reduce((n, l) => n + l.withheldUnits * (priceMap[l.dimension] ?? 0), 0);
      expect({ ctx, worth }).toEqual({ ctx, worth: plan.consumedCents });
      for (const line of plan.perLine) {
        expect({ ctx, ok: line.reportedQuantity >= 0 && line.withheldUnits >= 0 }).toEqual({ ctx, ok: true });
      }
    }
  });
});
