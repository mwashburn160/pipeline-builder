// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the extracted PluginOverview tab: the loading skeleton,
 * the no-data empty state (pluginSummary === null), and the data render
 * (inventory summary cards + type/compute distribution bars).
 */

import { render, screen } from '@testing-library/react';
import { PluginOverview } from '../src/components/reports/PluginOverview';
import type { PluginSummary, PluginDistribution } from '../src/components/reports/types';

const summary: PluginSummary = { total: 12, active: 9, inactive: 3, public: 5, private: 7, unique_names: 12 };
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
    expect(screen.getByText('By Plugin Type')).toBeInTheDocument();
    expect(screen.getByText('By Compute Type')).toBeInTheDocument();
    expect(screen.getByText('action')).toBeInTheDocument();
    expect(screen.getByText('lambda')).toBeInTheDocument();
  });
});
