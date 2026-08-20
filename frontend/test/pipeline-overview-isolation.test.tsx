// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation smoke tests for the PipelineOverview tab. DORA moved out to its own
 * feature-gated tab (see dora-report-isolation + dora-section tests); this file
 * asserts only PipelineOverview's three render branches (loading skeleton, empty
 * state, data).
 */

import { render, screen } from '@testing-library/react';
import { PipelineOverview } from '../src/components/reports/PipelineOverview';
import type { ExecutionCountRow } from '../src/types';
import type { TimelineEntry } from '../src/components/reports/types';

const execRow: ExecutionCountRow = {
  id: 'p1', project: 'Proj', organization: 'org-1', pipeline_name: 'Pipe One',
  total: 10, succeeded: 8, failed: 2, canceled: 0, first_execution: null, last_execution: null,
};
const timelineRow: TimelineEntry = { period: '2026-07-01T00:00:00.000Z', succeeded: 8, failed: 2, canceled: 0, success_pct: 80 };

const baseProps = {
  executions: [] as ExecutionCountRow[],
  timeline: [] as TimelineEntry[],
};

describe('PipelineOverview (isolation)', () => {
  it('renders the skeleton while loading with no data', () => {
    const { container } = render(<PipelineOverview {...baseProps} loading />);
    expect(container.querySelector('.skeleton')).toBeInTheDocument();
    expect(screen.queryByText('No pipeline data yet')).not.toBeInTheDocument();
  });

  it('renders the empty state when not loading and no data', () => {
    render(<PipelineOverview {...baseProps} loading={false} />);
    expect(screen.getByText('No pipeline data yet')).toBeInTheDocument();
  });

  it('renders summary stats + the execution timeline with data', () => {
    render(<PipelineOverview {...baseProps} loading={false} executions={[execRow]} timeline={[timelineRow]} />);
    expect(screen.getByText('Executions')).toBeInTheDocument();
    expect(screen.getByText('Success Rate')).toBeInTheDocument();
    expect(screen.getByText('80.0%')).toBeInTheDocument();
    expect(screen.getByText('Execution Timeline')).toBeInTheDocument();
    expect(screen.getByText('Success Rate Trend')).toBeInTheDocument();
  });

  it('does not render any DORA controls (they live on the DORA tab now)', () => {
    render(<PipelineOverview {...baseProps} loading={false} executions={[execRow]} />);
    expect(screen.queryByLabelText(/filter dora by pipeline/i)).not.toBeInTheDocument();
    expect(screen.queryByText('DORA Metrics')).not.toBeInTheDocument();
  });
});
