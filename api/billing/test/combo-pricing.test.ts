// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Combo-pricing math: quantity-aware satisfaction + exact max-weight set packing.
 * Pure functions — bundles/combos/addons are injected, so no Config bootstrap.
 */

import { jest, describe, it, expect } from '@jest/globals';

// combo-pricing only needs createLogger from api-core + Config from pipeline-core;
// mock both to avoid loading the real pipeline-core config graph (which pulls
// FEATURE_METADATA etc.). The pure functions take bundles/combos as args, so Config
// is never actually invoked here.
jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: () => undefined },
}));

const { activeComboCredits, comboBasisCents } = await import('../src/helpers/combo-pricing.js');

const bundle = (id: string, monthly: number) => ({
  id,
  name: id,
  description: '',
  grants: {},
  prices: { monthly, annual: monthly * 10 },
  stackable: false,
  availableForTiers: [],
  isActive: true,
  sortOrder: 0,
}) as never;

const combo = (id: string, bundleIds: string[], monthly: number, sortOrder: number, minQuantities?: Record<string, number>) => ({
  id,
  name: id,
  bundleIds,
  prices: { monthly, annual: monthly * 10 },
  sortOrder,
  isActive: true,
  ...(minQuantities ? { minQuantities } : {}),
}) as never;

const BUNDLES = [
  bundle('seat_pack', 2500),
  bundle('team_usage_analytics', 3000),
  bundle('advanced_reporting', 3000),
];
const TEAM_GROWTH = combo('team_growth', ['seat_pack', 'team_usage_analytics'], 3500, 1, { seat_pack: 1 });
const ANALYTICS_SUITE = combo('analytics_suite', ['advanced_reporting', 'team_usage_analytics'], 4000, 0);

describe('comboBasisCents', () => {
  it('sums member unit price × minQty (extra packs do not inflate it)', () => {
    // seat_pack 2500 × min 1 + tua 3000 × 1 = 5500, regardless of held quantity.
    expect(comboBasisCents(TEAM_GROWTH, BUNDLES, 'monthly')).toBe(5500);
    expect(comboBasisCents(TEAM_GROWTH, BUNDLES, 'annual')).toBe(55000);
  });
});

describe('activeComboCredits — quantity gate', () => {
  it('credits basis − combined ($55 − $35 = $20/mo) when Seat Pack + TUA held', () => {
    const out = activeComboCredits(
      [{ bundleId: 'seat_pack', quantity: 1 }, { bundleId: 'team_usage_analytics', quantity: 1 }],
      BUNDLES, [TEAM_GROWTH], 'monthly',
    );
    expect(out).toEqual([{ comboId: 'team_growth', name: 'team_growth', creditCents: 2000 }]);
  });

  it('does not fire when the Seat Pack add-on is absent (base seats do not count)', () => {
    expect(activeComboCredits([{ bundleId: 'team_usage_analytics', quantity: 1 }], BUNDLES, [TEAM_GROWTH], 'monthly')).toEqual([]);
  });

  it('the flat credit is unchanged by extra Seat Packs beyond the minimum', () => {
    const out = activeComboCredits(
      [{ bundleId: 'seat_pack', quantity: 5 }, { bundleId: 'team_usage_analytics', quantity: 1 }],
      BUNDLES, [TEAM_GROWTH], 'monthly',
    );
    expect(out[0].creditCents).toBe(2000);
  });
});

describe('activeComboCredits — overlap resolution (exact max-weight packing)', () => {
  it('grants ONE credit when two combos share a member (no double-count), tie → sortOrder', () => {
    // DORA + TUA + Seat Pack satisfies BOTH combos (each $20), sharing team_usage_analytics.
    const out = activeComboCredits(
      [{ bundleId: 'advanced_reporting', quantity: 1 }, { bundleId: 'team_usage_analytics', quantity: 1 }, { bundleId: 'seat_pack', quantity: 1 }],
      BUNDLES, [ANALYTICS_SUITE, TEAM_GROWTH], 'monthly',
    );
    expect(out).toHaveLength(1);
    expect(out[0].comboId).toBe('analytics_suite'); // sortOrder 0 wins the $20 tie
  });

  it('grants BOTH credits when combos are disjoint', () => {
    const b = [bundle('a', 1000), bundle('b', 1000), bundle('c', 1000), bundle('d', 1000)];
    const c1 = combo('c1', ['a', 'b'], 1500, 0); // basis 2000 − 1500 = 500
    const c2 = combo('c2', ['c', 'd'], 1500, 1); // basis 2000 − 1500 = 500
    const out = activeComboCredits(
      [{ bundleId: 'a', quantity: 1 }, { bundleId: 'b', quantity: 1 }, { bundleId: 'c', quantity: 1 }, { bundleId: 'd', quantity: 1 }],
      b, [c1, c2], 'monthly',
    );
    expect(out.map((x) => x.comboId).sort()).toEqual(['c1', 'c2']);
    expect(out.reduce((s, x) => s + x.creditCents, 0)).toBe(1000);
  });

  it('is EXACT, not greedy — picks B+C=24 over A=21 when A overlaps both', () => {
    // A{x,y}=21 overlaps B{x,z}=12 and C{y,w}=12; B and C are disjoint. Greedy takes A
    // (21) and drops both; exact packing takes B+C = 24.
    const b = [bundle('x', 100), bundle('y', 100), bundle('z', 100), bundle('w', 100)];
    const A = combo('A', ['x', 'y'], 179, 0); // basis 200 − 179 = 21
    const B = combo('B', ['x', 'z'], 188, 1); // basis 200 − 188 = 12
    const C = combo('C', ['y', 'w'], 188, 2); // basis 200 − 188 = 12
    const out = activeComboCredits(
      [{ bundleId: 'x', quantity: 1 }, { bundleId: 'y', quantity: 1 }, { bundleId: 'z', quantity: 1 }, { bundleId: 'w', quantity: 1 }],
      b, [A, B, C], 'monthly',
    );
    expect(out.map((x) => x.comboId).sort()).toEqual(['B', 'C']);
    expect(out.reduce((s, x) => s + x.creditCents, 0)).toBe(24);
  });

  it('drops a combo whose combined price yields no discount', () => {
    const noSave = combo('flat', ['seat_pack', 'team_usage_analytics'], 5500, 0); // basis 5500, combined 5500 → 0
    expect(activeComboCredits(
      [{ bundleId: 'seat_pack', quantity: 1 }, { bundleId: 'team_usage_analytics', quantity: 1 }],
      BUNDLES, [noSave], 'monthly',
    )).toEqual([]);
  });
});
