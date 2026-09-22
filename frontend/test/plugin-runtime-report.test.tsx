// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports → Plugins → Runs: the join of the two runtime routes (each projects
 * half of one per-version aggregate) and the panel's states.
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { PluginRuntime, pluginRuntimeLabel } from '../src/components/reports/PluginRuntime';
import { joinPluginRuntime } from '../src/components/reports/useReportData';

const rate = (over: Partial<Parameters<typeof joinPluginRuntime>[0][number]> = {}) => ({
  pluginPublisher: null, pluginName: 'trivy', pluginVersion: '1.0.0', runs: 10, succeeded: 9, failed: 1, successPct: 90,
  lastRun: '2026-09-20T00:00:00.000Z', ...over,
});

describe('joinPluginRuntime', () => {
  it('joins on publisher/name/version and orders by runs', () => {
    const rows = joinPluginRuntime(
      [rate(), rate({ pluginPublisher: 'acme', runs: 30 }), rate({ pluginVersion: '2.0.0', runs: 5 })],
      [
        { pluginPublisher: null, pluginName: 'trivy', pluginVersion: '1.0.0', p50Ms: 1000, p95Ms: 5000 },
        { pluginPublisher: 'acme', pluginName: 'trivy', pluginVersion: '1.0.0', p50Ms: 2000, p95Ms: 9000 },
      ],
    );
    expect(rows.map((r) => [pluginRuntimeLabel(r), r.pluginVersion, r.p50Ms])).toEqual([
      ['acme/trivy', '1.0.0', 2000],
      ['trivy', '1.0.0', 1000],
      ['trivy', '2.0.0', null],
    ]);
  });
});

describe('PluginRuntime', () => {
  it('shows the empty state with no runs', () => {
    render(<PluginRuntime loading={false} rows={[]} />);
    expect(screen.getByText('No plugin runs yet')).toBeInTheDocument();
  });

  it('shows the skeleton while loading', () => {
    const { container } = render(<PluginRuntime loading rows={[]} />);
    expect(container.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('renders each version with its success rate and durations', () => {
    render(<PluginRuntime loading={false} rows={joinPluginRuntime([rate({ pluginPublisher: 'acme' })], [])} />);
    expect(screen.getByText('Plugin runs')).toBeInTheDocument();
    expect(screen.getByText('acme/trivy')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });
});
