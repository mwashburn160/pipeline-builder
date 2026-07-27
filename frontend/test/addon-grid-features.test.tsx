// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AddonGrid discoverability: a feature bundle surfaces the human label of the
 * feature(s) it unlocks (flag → FEATURE_METADATA label), and a `?highlight=`
 * deep-link emphasizes the matching bundle card.
 */

import { render, screen } from '@testing-library/react';
import { AddonGrid } from '../src/components/billing/AddonGrid';
import type { Bundle } from '../src/types';

// scrollIntoView isn't implemented in jsdom.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

const doraBundle = {
  id: 'bundle-dora',
  name: 'Advanced Reporting (DORA)',
  description: 'DORA delivery analytics for your org.',
  grants: {},
  features: ['advanced_reporting'],
  prices: { monthly: 2900, annual: 29000 },
  stackable: false,
  availableForTiers: [],
} as unknown as Bundle;

const seatBundle = {
  id: 'bundle-seats',
  name: 'Seat Pack',
  description: 'Extra seats.',
  grants: { seats: 5 },
  prices: { monthly: 1000, annual: 10000 },
  stackable: true,
  availableForTiers: [],
} as unknown as Bundle;

const baseProps = {
  billingInterval: 'monthly' as const,
  bundleSelfService: true,
  actionLoading: false,
  previewLoading: false,
  addonQty: () => 0,
  requestAddonChange: jest.fn(),
};

describe('AddonGrid — feature discoverability', () => {
  it('shows the unlocked-feature label on a feature bundle', () => {
    render(<AddonGrid {...baseProps} bundles={[doraBundle]} />);
    // Flag mapped to its catalog label.
    expect(screen.getByText('Advanced Reporting')).toBeInTheDocument();
    expect(screen.getByText(/unlocks/i)).toBeInTheDocument();
  });

  it('omits the unlocks row for a capacity bundle with no features', () => {
    render(<AddonGrid {...baseProps} bundles={[seatBundle]} />);
    expect(screen.queryByText(/unlocks/i)).not.toBeInTheDocument();
  });

  it('scrolls the matching bundle into view when highlighted', () => {
    render(<AddonGrid {...baseProps} bundles={[seatBundle, doraBundle]} highlightFeature="advanced_reporting" />);
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
