// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests the seats row on the billing usage view. The rollup now carries a
 * pooled `seats: {used, limit}` block (or `null` when the platform read failed);
 * the card should surface seats-used-vs-limit alongside the other consumables,
 * render "Unlimited" for a -1 limit, and omit the row entirely when seats are null.
 */

import { render, screen } from '@testing-library/react';
import { UsageCard } from '../src/components/billing/UsageCard';
import type { UsageRollup } from '../src/types';

const baseRollup = (seats: UsageRollup['seats']): UsageRollup => ({
  period: { start: '2026-07-01T00:00:00Z', end: '2026-07-31T00:00:00Z', daysElapsed: 10, daysRemaining: 20 },
  subscription: null,
  usage: {
    pipelines: { used: 2, limit: 5, remaining: 3, percentOfLimit: 40, resetAt: '2026-08-01T00:00:00Z' },
  },
  seats,
  cost: { subscriptionCents: 0, currency: 'USD' },
});

describe('UsageCard — seats', () => {
  it('shows seats used vs limit with a percentage', () => {
    render(<UsageCard rollup={baseRollup({ used: 3, limit: 10 })} />);
    expect(screen.getByText('Seats')).toBeInTheDocument();
    expect(screen.getByText(/3 \/ 10/)).toBeInTheDocument();
    expect(screen.getByText(/\(30%\)/)).toBeInTheDocument();
  });

  it('renders "Unlimited" for a -1 seat limit', () => {
    render(<UsageCard rollup={baseRollup({ used: 12, limit: -1 })} />);
    expect(screen.getByText('Seats')).toBeInTheDocument();
    expect(screen.getByText(/12 \/ Unlimited/)).toBeInTheDocument();
  });

  it('omits the seats row when seat usage is unavailable (null)', () => {
    render(<UsageCard rollup={baseRollup(null)} />);
    expect(screen.queryByText('Seats')).not.toBeInTheDocument();
  });
});
