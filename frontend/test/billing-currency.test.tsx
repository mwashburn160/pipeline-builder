// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Prices render in the currency the billing response names, never an assumed
 * USD. Every priced billing DTO (plan, bundle, combo, price breakdown,
 * discount, promotion, subscription, plan preview, crossover) carries a
 * lower-case ISO `currency`; these cases hold the surfaces to it with a
 * non-dollar currency, where a missing pass-through shows up as a "$".
 */

import { describe, it, expect, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { formatDiscount } from '../src/components/discounts/formatDiscount';
import { AddonPreviewModal } from '../src/components/billing/AddonPreviewModal';
import { CrossoverCard } from '../src/components/quotas/CrossoverCard';
import { packForQuota } from '../src/lib/quota-pack-offer';
import type { AddonResult, Bundle, Discount } from '../src/types';

describe('billing currency pass-through', () => {
  it('formats a dollar-unit discount in its own currency', () => {
    const d = { id: 'd1', value: 2500, unit: 'dollar', currency: 'eur', kind: 'recurring', timesRedeemed: 0, isActive: true } as Discount;
    expect(formatDiscount(d)).toBe('€25.00 recurring');
  });

  it('itemizes an add-on preview in the breakdown currency', () => {
    const preview: AddonResult = {
      addons: [],
      effectiveLimits: {},
      priceBreakdown: { interval: 'monthly', currency: 'gbp', items: [{ label: 'Pro', quantity: 1, cents: 4900 }], totalCents: 4900 },
    };
    render(
      <AddonPreviewModal
        pendingAddon={{ bundleId: 'b', name: 'Pack', quantity: 1 }}
        addonPreview={preview}
        previewLoading={false}
        paymentRequired={false}
        actionLoading={false}
        portalLoading={false}
        onClose={jest.fn<AnyFn>()}
        onCancel={jest.fn<AnyFn>()}
        onConfirmAddonChange={jest.fn<AnyFn>()}
        onOpenBillingPortal={jest.fn<AnyFn>()}
      />,
    );
    expect(screen.getAllByText(/£49\.00/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$49\.00/)).not.toBeInTheDocument();
  });

  it('quotes the crossover figures in the response currency', () => {
    render(
      <CrossoverCard
        currency="eur"
        crossover={{
          crossover: true, tier: 'team', interval: 'monthly', currentCents: 27896, candidateTier: 'business',
          candidateCents: 24900, savingCents: 2996, retiredAddons: [], autoPrunedAddons: [], dropRequiredAddons: [],
          savingRequiresDrops: false, keptAddons: [],
        }}
      />,
    );
    expect(screen.getByTestId('crossover-card')).toHaveTextContent('€278.96');
  });

  it('carries the pack bundle currency onto the quota pack offer', () => {
    const pack = {
      id: 'p', name: 'Plugin Pack', description: '', grants: { plugins: 10 }, prices: { monthly: 1199, annual: 11990 },
      currency: 'cad', stackable: true, availableForTiers: ['pro'],
    } as Bundle;
    expect(packForQuota('plugins', [pack], 'monthly')).toMatchObject({ priceCents: 1199, currency: 'cad' });
  });
});
