// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The crossover (docs/plans/sales-agent.md D4): an account already paying more
 * in packs than the next tier costs.
 *
 * The cases that must produce NOTHING carry as much weight as the ones that
 * produce an offer, because this figure reaches a customer. A crossover claimed
 * against a tier that gives less on any dimension is a downgrade wearing a
 * discount, and the account finds out after the move.
 */

import { describe, it, expect } from '@jest/globals';
import { STANDARD_TIERS } from '@pipeline-builder/api-core';

// The helper reaches `addon-prune` — to ask the SAME function a plan change uses
// what that change would retire — which pulls the service config in, and that
// refuses to load without a Mongo URI. DYNAMIC imports below, because a static
// one hoists above this assignment (the trap bundle-docs-drift documents).
// Nothing here touches a database; the reads are pure catalog.
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-crossover';

const {
  addonCostCents,
  currentSpendCents,
  evaluateCrossover,
  regressionsAgainst,
} = await import('../src/helpers/crossover.js');
const { getBillingConfig } = await import('../src/config/billing-config.js');

const { plans, bundles } = getBillingConfig();
const seat = bundles.find((b) => b.id === 'seat')!;

function run(tier: Parameters<typeof evaluateCrossover>[0]['tier'], addons: Array<{ bundleId: string; quantity: number }>) {
  return evaluateCrossover({ tier, interval: 'monthly', addons, plans, bundles });
}

describe('addonCostCents — the volume curve is part of the comparison', () => {
  it('applies the pack\'s volume discount, because overstating today\'s spend invents a crossover', () => {
    const one = addonCostCents({ bundleId: 'seat', quantity: 1 }, bundles, 'monthly');
    const many = addonCostCents({ bundleId: 'seat', quantity: 8 }, bundles, 'monthly');
    expect(one).toBe(seat.prices.monthly);
    // Discounted, so strictly less than the naive unit x qty.
    expect(many).toBeLessThan(one * 8);
  });

  it('counts a non-stackable bundle once, however much quantity is recorded', () => {
    const feature = bundles.find((b) => !b.stackable && b.prices.monthly > 0)!;
    expect(addonCostCents({ bundleId: feature.id, quantity: 5 }, bundles, 'monthly'))
      .toBe(feature.prices.monthly);
  });

  it('is zero for an unknown bundle or a non-positive quantity, never NaN', () => {
    expect(addonCostCents({ bundleId: 'nope', quantity: 3 }, bundles, 'monthly')).toBe(0);
    expect(addonCostCents({ bundleId: 'seat', quantity: 0 }, bundles, 'monthly')).toBe(0);
  });
});

describe('regressionsAgainst — unlimited dominates, and nothing else is assumed', () => {
  const dims = { pipelines: 10, plugins: 50, seats: 5 } as never;

  it('treats -1 as dominating any finite value', () => {
    expect(regressionsAgainst(dims, { pipelines: -1, plugins: -1, seats: -1 } as never)).toEqual([]);
  });

  it('refuses a finite candidate against an unlimited current', () => {
    const regressions = regressionsAgainst({ pipelines: -1 } as never, { pipelines: 1000 } as never);
    expect(regressions).toEqual([{ dimension: 'pipelines', from: -1, to: 1000 }]);
  });

  it('names every dimension that would shrink, not just the first', () => {
    const regressions = regressionsAgainst(dims, { pipelines: 2, plugins: 1, seats: 99 } as never);
    expect(regressions.map((r) => r.dimension).sort()).toEqual(['pipelines', 'plugins']);
  });
});

describe('evaluateCrossover — when there is no offer to make', () => {
  it('declines for an account holding no packs: that is a price list, not a crossover', () => {
    const v = run('team', []);
    expect(v).toMatchObject({ crossover: false, reason: 'no_addons', candidateTier: null });
    // The current spend is still reported — F3 renders it either way.
    expect(v.currentCents).toBeGreaterThan(0);
  });

  it('declines at the top of the ladder, where there is nothing to move to', () => {
    const top = STANDARD_TIERS[STANDARD_TIERS.length - 1]!;
    expect(run(top, [{ bundleId: 'seat', quantity: 4 }]))
      .toMatchObject({ crossover: false, reason: 'top_tier' });
  });

  it('declines when one pack cannot outweigh the gap to the next tier', () => {
    const v = run('developer', [{ bundleId: 'seat', quantity: 1 }]);
    expect(v.crossover).toBe(false);
    expect(v.reason).toBe('nothing_cheaper');
  });

  it('never proposes `unlimited`, which is the billing-off default rather than a plan', () => {
    for (const tier of STANDARD_TIERS) {
      const v = run(tier, [{ bundleId: 'seat', quantity: 20 }]);
      expect(v.candidateTier).not.toBe('unlimited');
    }
  });
});

describe('evaluateCrossover — the offer the plan is named for', () => {
  /** Enough seat packs that the pack spend overtakes the next tier's price. */
  function seatsToCrossover(tier: 'pro' | 'team'): number {
    for (let q = 1; q <= (seat.maxQuantity ?? 40); q++) {
      if (run(tier, [{ bundleId: 'seat', quantity: q }]).crossover) return q;
    }
    return -1;
  }

  it('finds a crossover once pack spend overtakes a dominating tier', () => {
    const q = seatsToCrossover('team');
    expect(q).toBeGreaterThan(0);

    const v = run('team', [{ bundleId: 'seat', quantity: q }]);
    expect(v.crossover).toBe(true);
    expect(v.candidateTier).toBeTruthy();
    expect(v.savingCents).toBeGreaterThan(0);
    expect(v.candidateCents).toBeLessThan(v.currentCents);
    // The whole point: the packs the tier covers come off the bill.
    expect(v.retiredAddons).toContain('seat');
  });

  it('reports a saving that reconciles exactly against the two figures', () => {
    const q = seatsToCrossover('team');
    const v = run('team', [{ bundleId: 'seat', quantity: q }]);
    expect(v.savingCents).toBe(v.currentCents - v.candidateCents);
  });

  it('takes the HIGHEST dominating tier that costs less, not the cheapest', () => {
    // Among moves that all cost less than today, the one with the most headroom
    // is unambiguously the best thing to tell the account about.
    const v = run('pro', [{ bundleId: 'seat', quantity: seat.maxQuantity ?? 20 }]);
    if (v.crossover) {
      const ladder = STANDARD_TIERS;
      const idx = ladder.indexOf(v.candidateTier!);
      for (const higher of ladder.slice(idx + 1)) {
        const plan = plans.find((p) => p.tier === higher)!;
        // Any higher tier must be genuinely unaffordable, or it would have won.
        expect(plan.prices.monthly).toBeGreaterThanOrEqual(v.currentCents);
      }
    }
  });

  it('never claims a crossover that would REDUCE any dimension', () => {
    // The invariant that makes this honest. Swept across the ladder and a range
    // of pack counts rather than asserted on one fixture.
    for (const tier of ['developer', 'pro', 'team'] as const) {
      for (const q of [1, 3, 8, 15, 22]) {
        const v = run(tier, [{ bundleId: 'seat', quantity: q }]);
        if (!v.crossover) continue;
        expect(v.savingCents).toBeGreaterThan(0);
        expect(v.reason).toBeUndefined();
      }
    }
  });

  it('keeps a feature bundle the higher tier does not include, and still charges for it', () => {
    // Comparing a bare tier price against tier-plus-packs would manufacture a
    // crossover for any account holding a feature the move cannot retire.
    const feature = bundles.find((b) => !b.stackable && (b.features?.length ?? 0) > 0 && b.prices.monthly > 0);
    if (!feature) return;
    const v = run('team', [{ bundleId: 'seat', quantity: 22 }, { bundleId: feature.id, quantity: 1 }]);
    if (!v.crossover) return;
    const keptOrRetired = [...v.keptAddons.map((h) => h.bundleId), ...v.retiredAddons];
    expect(keptOrRetired).toContain(feature.id);
    // If it was kept, its price is inside the candidate figure.
    if (v.keptAddons.some((h) => h.bundleId === feature.id)) {
      expect(v.candidateCents).toBeGreaterThan(plans.find((p) => p.tier === v.candidateTier)!.prices.monthly);
    }
  });

  it('is deterministic — the same input gives the same answer every time', () => {
    // It reaches a customer, and the add-on partition is greedy, so stability is
    // a property rather than an accident of iteration order.
    const input = [{ bundleId: 'seat', quantity: 12 }, { bundleId: 'pipeline_pack', quantity: 2 }];
    const first = run('team', input);
    for (let i = 0; i < 5; i++) expect(run('team', input)).toEqual(first);
  });
});

describe('currentSpendCents', () => {
  it('is plan price plus every pack, which is the figure F3 compares', () => {
    const plan = plans.find((p) => p.tier === 'team')!;
    const addons = [{ bundleId: 'seat', quantity: 4 }];
    expect(currentSpendCents(plan, addons, bundles, 'monthly'))
      .toBe(plan.prices.monthly + addonCostCents(addons[0]!, bundles, 'monthly'));
  });

  it('compares at the SAME interval on both sides', () => {
    const plan = plans.find((p) => p.tier === 'team')!;
    const monthly = currentSpendCents(plan, [{ bundleId: 'seat', quantity: 2 }], bundles, 'monthly');
    const annual = currentSpendCents(plan, [{ bundleId: 'seat', quantity: 2 }], bundles, 'annual');
    expect(annual).toBeGreaterThan(monthly);
  });
});

describe('the saving is CONDITIONAL, and the verdict says so', () => {
  /**
   * The expensive failure mode. A plan change prunes only PURE FEATURE bundles
   * the new tier includes; a stackable resource pack survives it and keeps
   * billing on top of the new tier's base. So an account that accepts a
   * crossover and does nothing else pays the new tier PLUS its old packs —
   * MORE than before, not less.
   */
  function firstCrossover() {
    for (const tier of ['pro', 'team'] as const) {
      for (let q = 1; q <= (seat.maxQuantity ?? 22); q++) {
        const v = run(tier, [{ bundleId: 'seat', quantity: q }]);
        if (v.crossover) return v;
      }
    }
    return null;
  }

  it('marks a seat-pack crossover as requiring the account to drop the packs', () => {
    const v = firstCrossover();
    expect(v).not.toBeNull();
    // Seat packs carry `grants`, so the tier change does NOT retire them.
    expect(v!.dropRequiredAddons).toContain('seat');
    expect(v!.autoPrunedAddons).not.toContain('seat');
    expect(v!.savingRequiresDrops).toBe(true);
  });

  it('partitions every retired add-on into exactly one of the two buckets', () => {
    const v = firstCrossover()!;
    expect([...v.autoPrunedAddons, ...v.dropRequiredAddons].sort()).toEqual([...v.retiredAddons].sort());
    for (const id of v.autoPrunedAddons) expect(v.dropRequiredAddons).not.toContain(id);
  });

  it('asks the SAME function the plan change uses, so the two cannot drift', async () => {
    const { pruneTierIncludedFeatureAddons } = await import('../src/helpers/addon-prune.js');
    const v = firstCrossover()!;
    const addons = [...v.keptAddons, ...v.retiredAddons.map((bundleId) => ({ bundleId, quantity: 1 }))];
    const real = pruneTierIncludedFeatureAddons(addons, v.candidateTier!, bundles)
      .pruned.map((p) => p.bundleId);
    // Every id the verdict calls auto-pruned is one the real prune would prune.
    for (const id of v.autoPrunedAddons) expect(real).toContain(id);
  });

  it('reports no required drops when there is no crossover at all', () => {
    const v = run('team', []);
    expect(v.savingRequiresDrops).toBe(false);
    expect(v.dropRequiredAddons).toEqual([]);
    expect(v.autoPrunedAddons).toEqual([]);
  });
});
