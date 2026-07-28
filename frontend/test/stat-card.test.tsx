// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the shared StatCard. Covers both layouts: `centered`
 * (summary-stat: value over label) and `detailed` (label + optional badge on
 * top, value, sub line). The variant API is a discriminated union so `sub`/
 * `badge` only compile on the detailed variant.
 */

import { render, screen } from '@testing-library/react';
import { StatCard } from '../src/components/reports/StatCard';

describe('StatCard', () => {
  it('renders the centered variant (default) with value + label', () => {
    render(<StatCard label="Executions" value={42} />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Executions')).toBeInTheDocument();
  });

  it('renders the detailed variant with a badge and sub line', () => {
    render(
      <StatCard
        variant="detailed"
        label="Deployment Frequency"
        value="8"
        sub="deploys · 0.27/day"
        badge={<span>Elite</span>}
      />,
    );
    expect(screen.getByText('Deployment Frequency')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('deploys · 0.27/day')).toBeInTheDocument();
    expect(screen.getByText('Elite')).toBeInTheDocument();
  });

  it('spreads wrapperProps onto the card (e.g. a focusable tooltip group)', () => {
    render(
      <StatCard variant="detailed" label="MTTR" value="—" wrapperProps={{ tabIndex: 0, role: 'group' }} />,
    );
    expect(screen.getByRole('group')).toHaveAttribute('tabindex', '0');
  });
});
