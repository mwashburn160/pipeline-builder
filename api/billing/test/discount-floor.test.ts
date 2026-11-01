// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The aggregate discount floor.
 *
 * `BILLING_DISCOUNT_MAX_PERCENT` and `_MAX_CENTS` bound ONE coupon at mint time.
 * Nothing bounded the stack, and that mattered because four reductions compose on
 * the same list as additive CREDITS rather than compounding factors:
 *
 *   - the annual interval      10x monthly, so ~17% off twelve months;
 *   - a volume curve           up to 30% (`seat`, `support_standard`, capacity packs);
 *   - a combo credit           ~30% on every combo in the catalog;
 *   - a coupon                 up to `maxPercent`, 50% by default.
 *
 * A SCOPED coupon takes its percentage of the same base a volume curve has already
 * discounted, and neither knows about the other. The author of the support curves
 * already hit this and solved it locally — "The caps also protect the ANNUAL stack
 * … an uncapped -30% put 20 annual premium contacts at 41.7% below monthly list" —
 * which is a hand-tuned curve guarding a risk with no guard. This is the guard.
 *
 * Two halves, deliberately:
 *   1. The CATALOG stack (interval + volume + combo) has no human in the loop, so
 *      it is asserted to sit at or above the floor on its own.
 *   2. A COUPON on top is refused at redemption by `discountFloorBreach`, because
 *      that is the only point where the holder's full composition is known — codes
 *      are global, so mint time cannot know who will redeem one.
 */

import { readFileSync } from 'fs';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { loadBillingConfig } from '../src/config/billing-config.js';
import type { BundleConfig, ComboDiscountConfig } from '../src/config/billing-types.js';
import { activeComboCredits, volumeCredits, priceForInterval } from '../src/helpers/combo-pricing.js';

const FLOOR = 40; // config default; asserted below so the two cannot drift

/** The worst (deepest) catalog-only discount reachable for one combo, as a percent of list. */
function deepestCatalogStack(
  combo: ComboDiscountConfig,
  bundles: readonly BundleConfig[],
  combos: readonly ComboDiscountConfig[],
  interval: 'monthly' | 'annual',
): { pct: number; detail: string } {
  // Hold each member at the quantity that maximises its volume discount, which is
  // the worst case for the floor — the top `volumeTiers` threshold, or the combo's
  // own minimum where it demands more.
  const addons = combo.bundleIds.map((id) => {
    const b = bundles.find((x) => x.id === id);
    const top = b?.volumeTiers?.length ? b.volumeTiers[b.volumeTiers.length - 1]!.minQuantity : 1;
    return { bundleId: id, quantity: Math.max(top, combo.minQuantities?.[id] ?? 1) };
  });

  let listCents = 0;
  for (const a of addons) {
    const b = bundles.find((x) => x.id === a.bundleId);
    if (b) listCents += priceForInterval(b.prices, interval) * a.quantity;
  }
  const comboCents = activeComboCredits(addons, bundles, combos, interval)
    .reduce((n, c) => n + c.creditCents, 0);
  const volumeCents = volumeCredits(addons, bundles, interval)
    .reduce((n, c) => n + c.creditCents, 0);
  const pct = listCents > 0 ? ((comboCents + volumeCents) * 100) / listCents : 0;
  return {
    pct,
    detail: `${combo.id}/${interval}: list ${listCents}, combo ${comboCents}, volume ${volumeCents}`,
  };
}

describe('aggregate discount floor', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.BILLING_DISCOUNT_FLOOR_PERCENT; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults the floor to 40% of list', () => {
    // Read from source rather than from `config`: importing src/config.js throws
    // without MONGODB_URI (it validates at module load), and booting Mongo to
    // read one integer default would make this suite slow and flaky for nothing.
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf-8');
    const found = /floorPercent: intSetting\('BILLING_DISCOUNT_FLOOR_PERCENT', (\d+)/.exec(src);
    // Pinned so the comments quoting "60% off is exactly reachable" stay true.
    expect(found?.[1]).toBe(String(FLOOR));
  });

  it('keeps the catalog-only stack (volume + combo) at or above the floor', () => {
    const { bundles, comboDiscounts } = loadBillingConfig();
    const breaches: string[] = [];
    for (const combo of comboDiscounts) {
      for (const interval of ['monthly', 'annual'] as const) {
        const { pct, detail } = deepestCatalogStack(combo, bundles, comboDiscounts, interval);
        if (pct > 100 - FLOOR) breaches.push(`${detail} -> ${pct.toFixed(1)}% off`);
      }
    }
    expect({
      breaches,
      fix: 'A combo and a volume curve discount the SAME base additively, so their maxima add. '
        + 'Either lower one of them, or raise BILLING_DISCOUNT_FLOOR_PERCENT deliberately — but note '
        + 'that a catalog stack already at the floor leaves a coupon no headroom at all, and every '
        + 'redemption on such an account will be refused DISCOUNT_FLOOR_BREACHED.',
    }).toEqual({ breaches: [], fix: expect.any(String) });
  });

  it('guards the guard: the catalog really does reach a deep discount', () => {
    // A scan that found nothing would make the assertion above vacuously true.
    const { bundles, comboDiscounts } = loadBillingConfig();
    const deepest = Math.max(
      ...comboDiscounts.flatMap((c) => (['monthly', 'annual'] as const)
        .map((i) => deepestCatalogStack(c, bundles, comboDiscounts, i).pct)),
    );
    expect(deepest).toBeGreaterThan(25);
  });
});
