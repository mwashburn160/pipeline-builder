// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Marketplace metered usage-credit drawdown (Phase 10, opt-in).
 * Pure — no mocks.
 */

import { describe, it, expect } from '@jest/globals';
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
