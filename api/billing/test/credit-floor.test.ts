// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The STANDING figure a subscription's recurring discount contributes to the
 * aggregate floor (and to the plan preview's "what the account keeps") must be
 * what the per-period re-grant actually grants. A bundle-scoped DOLLAR rule is
 * capped at the scoped subtotal each period (`grantPeriodicCredits`), so the
 * standing figure is capped the same way — otherwise the floor counted credit
 * the account never receives and refused coupons/promotions that fit.
 */

import { jest, describe, it, expect } from '@jest/globals';
import type { BundleConfig } from '../src/config/billing-types.js';

// src/config.js validates MONGODB_URI at load; the floor reads only this slice.
jest.unstable_mockModule('../src/config.js', () => ({ config: { discounts: { floorPercent: 40 } } }));
const { recurringDiscountStandingCents } = await import('../src/helpers/credit-floor.js');

const bundles = [
  { id: 'support_standard', name: 'Standard Support', prices: { monthly: 1999, annual: 19999 } },
] as unknown as BundleConfig[];

describe('recurringDiscountStandingCents', () => {
  it('caps a bundle-scoped dollar rule at the scoped subtotal, as the re-grant does', () => {
    const cents = recurringDiscountStandingCents(
      {
        recurringDiscount: { discountId: 'd', unit: 'dollar', value: 5000, appliesToBundles: ['support_standard'], appliedAt: new Date() },
        addons: [{ bundleId: 'support_standard', quantity: 1 }],
        interval: 'monthly',
      } as never,
      4900,
      bundles,
    );
    expect(cents).toBe(1999);
  });

  it('is 0 for a bundle-scoped dollar rule once the scoped bundle is gone', () => {
    const cents = recurringDiscountStandingCents(
      {
        recurringDiscount: { discountId: 'd', unit: 'dollar', value: 5000, appliesToBundles: ['support_standard'], appliedAt: new Date() },
        addons: [],
        interval: 'monthly',
      } as never,
      4900,
      bundles,
    );
    expect(cents).toBe(0);
  });

  it('leaves an unscoped dollar rule at its full amount', () => {
    const cents = recurringDiscountStandingCents(
      { recurringDiscount: { discountId: 'd', unit: 'dollar', value: 5000, appliedAt: new Date() }, addons: [], interval: 'monthly' } as never,
      4900,
      bundles,
    );
    expect(cents).toBe(5000);
  });
});
