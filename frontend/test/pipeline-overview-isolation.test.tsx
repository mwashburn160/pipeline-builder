// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation smoke tests for the extracted PipelineOverview tab. The DORA
 * sub-behaviors (fetch wiring, debounce) are covered by the page-level
 * dora-section tests; here we assert the three render branches (loading
 * skeleton, empty state, data) and that the collapsed `doraScope` bag reaches
 * DoraScopeControls when entitled.
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

const doraScope = {
  pipelineId: '', environment: '', deploysOnly: false,
  onPipelineChange: jest.fn(), onEnvironmentChange: jest.fn(),
  onEnvironmentCommit: jest.fn(), onDeploysOnlyChange: jest.fn(),
};

const baseProps = {
  executions: [] as ExecutionCountRow[], timeline: [] as TimelineEntry[],
  dora: null, doraTrend: [], doraEnabled: false, doraScope,
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
    // Stacked timeline bar total surfaces for the single period.
    expect(screen.getByText('Success Rate Trend')).toBeInTheDocument();
  });

  it('forwards the doraScope bag to the scope controls when entitled', () => {
    render(<PipelineOverview {...baseProps} loading={false} executions={[execRow]} doraEnabled />);
    expect(screen.getByLabelText(/filter dora by pipeline/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/filter dora by environment/i)).toBeInTheDocument();
  });
});
