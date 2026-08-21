// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render tests for the Build Health sub-panel (Phase 6) shown next to DORA: the
 * per-stage table (runs / success rate / p50-p90-p99), the totals line, the
 * "pick a pipeline" hint when none is scoped, and the empty state.
 */

import { render, screen } from '@testing-library/react';
import type { BuildHealth } from '../src/lib/api/domains/reporting';
import { BuildHealthPanel } from '../src/components/reports/BuildHealth';

const sample: BuildHealth = {
  stages: [
    { stage: 'Build', runs: 10, successes: 8, failures: 2, successRate: 80, p50Ms: 1000, p90Ms: 2000, p99Ms: 3000 },
    { stage: 'Deploy', runs: 5, successes: 5, failures: 0, successRate: 100, p50Ms: 5000, p90Ms: 6000, p99Ms: 7000 },
  ],
  totals: { runs: 15, failures: 2, failureRate: 13.3 },
};

describe('BuildHealthPanel', () => {
  it('prompts to pick a pipeline when none is scoped', () => {
    render(<BuildHealthPanel loading={false} buildHealth={null} pipelineSelected={false} />);
    expect(screen.getByText(/Select a pipeline/i)).toBeInTheDocument();
  });

  it('renders the empty state when the scoped pipeline has no stage activity', () => {
    render(<BuildHealthPanel loading={false} buildHealth={{ stages: [], totals: { runs: 0, failures: 0, failureRate: 0 } }} pipelineSelected />);
    expect(screen.getByText(/No stage activity/i)).toBeInTheDocument();
  });

  it('renders per-stage rows, success rates, and the totals line', () => {
    render(<BuildHealthPanel loading={false} buildHealth={sample} pipelineSelected />);
    expect(screen.getByText('Build Health')).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('Deploy')).toBeInTheDocument();
    // Per-stage success rate pills.
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    // Totals line: 15 stage runs · 13.3% failed.
    expect(screen.getByText(/15 stage runs/i)).toBeInTheDocument();
    expect(screen.getByText(/13\.3% failed/i)).toBeInTheDocument();
  });
});
