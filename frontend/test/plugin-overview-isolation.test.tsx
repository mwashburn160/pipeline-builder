// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the extracted PluginOverview tab: the loading skeleton,
 * the no-data empty state (pluginSummary === null), and the data render
 * (inventory summary cards + type/compute distribution bars).
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { PluginOverview } from '../src/components/reports/PluginOverview';
import type { PluginSummary, PluginDistribution } from '../src/components/reports/types';

const summary: PluginSummary = { total: 12, active: 9, inactive: 3, public: 5, org: 4, private: 3, unique_names: 12 };
const distribution: PluginDistribution[] = [
  { plugin_type: 'action', compute_type: 'lambda', count: 8 },
  { plugin_type: 'source', compute_type: 'fargate', count: 4 },
];

describe('PluginOverview (isolation)', () => {
  it('renders the skeleton while loading with no summary', () => {
    const { container } = render(<PluginOverview loading pluginSummary={null} distribution={[]} />);
    expect(container.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('renders the empty state when not loading and no summary', () => {
    render(<PluginOverview loading={false} pluginSummary={null} distribution={[]} />);
    expect(screen.getByText('No plugin data yet')).toBeInTheDocument();
  });

  it('renders inventory cards and distribution bars with data', () => {
    render(<PluginOverview loading={false} pluginSummary={summary} distribution={distribution} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('By plugin type')).toBeInTheDocument();
    expect(screen.getByText('By compute type')).toBeInTheDocument();
    expect(screen.getByText('action')).toBeInTheDocument();
    expect(screen.getByText('lambda')).toBeInTheDocument();
  });

  it('shows the org-visibility bucket, so the visibility cards add up to Total', () => {
    // The server counts one bucket per visibility rung (public / org / private);
    // without an Org card, 5 public + 3 private sat under a Total of 12.
    render(<PluginOverview loading={false} pluginSummary={summary} distribution={[]} />);
    const card = (label: string) => screen.getByText(label).parentElement!;
    expect(card('Public')).toHaveTextContent('5');
    expect(card('Org')).toHaveTextContent('4');
    expect(card('Private')).toHaveTextContent('3');
  });
});
