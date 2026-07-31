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

describe('AddonGrid — combo "pair to save" nudge', () => {
  const tuaBundle = {
    id: 'bundle-tua', name: 'Team Usage Analytics', description: 'Per-team usage.',
    grants: {}, features: ['team_usage_analytics'], prices: { monthly: 3000, annual: 30000 },
    stackable: false, availableForTiers: [],
  } as unknown as Bundle;
  const combo = {
    id: 'analytics_suite', name: 'Analytics Suite',
    bundleIds: ['bundle-dora', 'bundle-tua'], savings: { monthly: 2000, annual: 20000 },
  };

  it('nudges on the UN-owned member when the other member is already owned', () => {
    // TUA owned (qty 1), DORA not → the DORA card prompts to complete the suite.
    render(
      <AddonGrid
        {...baseProps}
        bundles={[doraBundle, tuaBundle]}
        addonQty={(id) => (id === 'bundle-tua' ? 1 : 0)}
        comboDiscounts={[combo]}
      />,
    );
    expect(screen.getByText(/Completes the Analytics Suite — save \$20\.00\/mo/i)).toBeInTheDocument();
  });

  it('does not nudge when neither member is owned', () => {
    render(<AddonGrid {...baseProps} bundles={[doraBundle, tuaBundle]} addonQty={() => 0} comboDiscounts={[combo]} />);
    expect(screen.queryByText(/Completes the/i)).not.toBeInTheDocument();
  });

  it('does not nudge a member that is already owned (combo already complete)', () => {
    render(<AddonGrid {...baseProps} bundles={[doraBundle, tuaBundle]} addonQty={() => 1} comboDiscounts={[combo]} />);
    expect(screen.queryByText(/Completes the/i)).not.toBeInTheDocument();
  });

  it('is quantity-aware: fires below a member minimum, clears once met', () => {
    // Seat Pack combo needs qty ≥ 2; TUA owned. seat card at qty 1 → still nudged.
    const seatCombo = { id: 'seaty', name: 'Seat Combo', bundleIds: ['bundle-seats', 'bundle-tua'], minQuantities: { 'bundle-seats': 2 }, savings: { monthly: 1500, annual: 15000 } };
    const props = { ...baseProps, bundles: [seatBundle, tuaBundle], comboDiscounts: [seatCombo] };
    const { rerender } = render(<AddonGrid {...props} addonQty={(id) => (id === 'bundle-tua' ? 1 : 1)} />);
    expect(screen.getByText(/Completes the Seat Combo/i)).toBeInTheDocument();
    rerender(<AddonGrid {...props} addonQty={() => 2} />); // seats now meet min → no nudge
    expect(screen.queryByText(/Completes the Seat Combo/i)).not.toBeInTheDocument();
  });

  it('shows only the higher-savings combo when a card completes two', () => {
    // The DORA card completes both combos (TUA + seats owned); show the bigger one.
    const small = { id: 'small', name: 'Small', bundleIds: ['bundle-dora', 'bundle-tua'], savings: { monthly: 1000, annual: 10000 } };
    const big = { id: 'big', name: 'Big', bundleIds: ['bundle-dora', 'bundle-seats'], savings: { monthly: 2500, annual: 25000 } };
    render(
      <AddonGrid
        {...baseProps}
        bundles={[doraBundle, tuaBundle, seatBundle]}
        addonQty={(id) => (id === 'bundle-dora' ? 0 : 1)}
        comboDiscounts={[small, big]}
      />,
    );
    expect(screen.getByText(/Completes the Big — save \$25\.00\/mo/i)).toBeInTheDocument();
    expect(screen.queryByText(/Completes the Small/i)).not.toBeInTheDocument();
  });
});
