// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * No tier is dominated by a basket of add-on packs.
 *
 * Packs exist so an account can exceed its tier without upgrading — that is the
 * product, not a leak. The leak would be a tier nobody should ever buy: if the
 * cheapest pack basket that reaches EVERY limit of tier N+1, bought while sitting
 * on tier N, costs less than the upgrade, then tier N+1 is priced above its own
 * contents and the ladder has a rung that only uninformed customers land on.
 *
 * This is easy to get wrong by eye, and was: a review of this catalog claimed
 * `business` + 2 Pipeline Packs reached enterprise capacity for $308.98 against
 * $899, and called enterprise dominated. It compared one axis. Enterprise also
 * carries 7 more seats, 700k more API calls, 1,400 more AI calls, 130 GB, 50
 * listings and unlimited `idpConfigs`; buying all of it with packs costs about
 * $1,006 against a $650 upgrade. The ladder was fine and the analysis was not,
 * which is why this is computed rather than asserted from a comment.
 *
 * Two dimensions are deliberately UNREACHABLE by packs and that is the fence
 * doing its job: `seat` and `pipeline_pack` are Team+ only (api-core's
 * SEAT_PACK_TIERS), so a single-seat Developer/Pro cannot stack its way to Team,
 * and `idpConfigs` has no pack at all, so enterprise's unlimited SSO cannot be
 * bought on a lower tier at any price. A step with an unreachable dimension is
 * recorded as such instead of being scored, because "cheaper" is meaningless when
 * the basket cannot get there.
 */

import { describe, it, expect } from '@jest/globals';
import { QUOTA_TIERS, VALID_TIERS, type QuotaTier, type QuotaTierLimits } from '@pipeline-builder/api-core';
import { loadBillingConfig } from '../src/config/billing-config.js';
import type { BundleConfig } from '../src/config/billing-types.js';
import { volumeDiscountPct } from '../src/helpers/combo-pricing.js';

/** The countable limits a pack could plausibly top up. */
const DIMS: (keyof QuotaTierLimits)[] = [
  'seats', 'plugins', 'pipelines', 'apiCalls', 'aiCalls', 'storageBytes', 'listings', 'idpConfigs',
];

interface StepResult {
  from: QuotaTier;
  to: QuotaTier;
  upgradeCents: number;
  basketCents: number;
  unreachable: (keyof QuotaTierLimits)[];
}

/** Cheapest monthly pack spend on `from` that reaches every limit of `to`. */
function cheapestBasket(from: QuotaTier, to: QuotaTier, bundles: readonly BundleConfig[]): StepResult {
  const lo = QUOTA_TIERS[from].limits;
  const hi = QUOTA_TIERS[to].limits;
  let basketCents = 0;
  const unreachable: (keyof QuotaTierLimits)[] = [];

  for (const dim of DIMS) {
    const have = lo[dim] ?? 0;
    const want = hi[dim] ?? 0;
    // Unlimited on the target: no finite quantity of packs reaches it.
    if (want === -1 && have !== -1) { unreachable.push(dim); continue; }
    const need = want - have;
    if (need <= 0) continue;

    let best: number | null = null;
    for (const b of bundles) {
      if (!b.isActive || !b.stackable) continue;
      if (!b.availableForTiers.includes(from)) continue;
      const grant = b.grants?.[dim];
      if (!grant || grant <= 0) continue;
      const n = Math.ceil(need / grant);
      if (b.maxQuantity !== undefined && n > b.maxQuantity) continue;
      const gross = b.prices.monthly * n;
      const cents = Math.round((gross * (100 - volumeDiscountPct(b, n))) / 100);
      if (best === null || cents < best) best = cents;
    }
    if (best === null) { unreachable.push(dim); continue; }
    basketCents += best;
  }

  const plans = loadBillingConfig().plans;
  const price = (t: QuotaTier) => plans.find((p) => p.tier === t)?.prices.monthly ?? 0;
  return { from, to, upgradeCents: price(to) - price(from), basketCents, unreachable };
}

describe('tier ladder coherence', () => {
  const { bundles } = loadBillingConfig();
  // Adjacent pairs of the purchasable ladder; `unlimited` is the billing-off
  // default and is never selectable, so it has no rung above it to compare.
  const ladder = VALID_TIERS.filter((t) => t !== 'unlimited');
  const steps = ladder.slice(0, -1).map((t, i) => cheapestBasket(t, ladder[i + 1]!, bundles));

  it('never prices a tier above the packs that would replace it', () => {
    const dominated = steps
      .filter((s) => s.unreachable.length === 0 && s.basketCents < s.upgradeCents)
      .map((s) => `${s.from}->${s.to}: upgrade ${s.upgradeCents}c but packs reach every limit for ${s.basketCents}c`);
    expect({
      dominated,
      fix: 'A pack basket now reaches every limit of the next tier for less than the upgrade, so '
        + 'that tier is priced above its own contents. Either raise the pack prices, cap them with '
        + 'maxQuantity, restrict availableForTiers, or lower the tier — but do not leave a rung on '
        + 'the ladder that no informed customer should buy.',
    }).toEqual({ dominated: [], fix: expect.any(String) });
  });

  it('keeps seats and pipelines unreachable from the single-seat tiers', () => {
    // SEAT_PACK_TIERS is the fence: Developer/Pro must upgrade to grow a team
    // rather than stacking the differentiator. If a pack ever becomes available
    // there, this step stops being "unreachable" and the assertion above starts
    // scoring it — which is the intended pressure, but it should be a decision.
    const proToTeam = steps.find((s) => s.from === 'pro' && s.to === 'team')!;
    expect(proToTeam.unreachable).toEqual(expect.arrayContaining(['seats', 'pipelines']));
  });

  it('guards the guard: the baskets are actually priced, not silently empty', () => {
    // Every dimension landing in `unreachable` would make the comparison vacuous.
    const priced = steps.filter((s) => s.basketCents > 0);
    expect(priced.length).toBeGreaterThanOrEqual(3);
    for (const s of steps) expect(s.upgradeCents).toBeGreaterThan(0);
  });
});
