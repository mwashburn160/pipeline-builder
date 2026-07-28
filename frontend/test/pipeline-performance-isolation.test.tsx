// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the extracted PipelinePerformance tab: the loading
 * skeleton, the no-data empty state, and the data render (executions +
 * durations tables and the stage-bottleneck list).
 */

import { render, screen } from '@testing-library/react';
import { PipelinePerformance } from '../src/components/reports/PipelinePerformance';
import type { ExecutionCountRow } from '../src/types';
import type { DurationStat, StageBottleneck } from '../src/components/reports/types';

const execRow: ExecutionCountRow = {
  id: 'p1', project: 'Proj', organization: 'org-1', pipeline_name: 'Pipe One',
  total: 10, succeeded: 8, failed: 2, canceled: 0, first_execution: null, last_execution: null,
};
const duration: DurationStat = { id: 'p1', project: 'Proj', pipeline_name: 'Pipe One', avg_ms: 5000, min_ms: 1000, max_ms: 9000, p95_ms: 8000, executions: 10 };
const bottleneck: StageBottleneck = { id: 'p1', pipeline_name: 'Pipe One', stage_name: 'build', avg_ms: 4000, max_ms: 7000 };

const base = { executions: [] as ExecutionCountRow[], durations: [] as DurationStat[], bottlenecks: [] as StageBottleneck[] };

describe('PipelinePerformance (isolation)', () => {
  it('renders the skeleton while loading with no data', () => {
    const { container } = render(<PipelinePerformance {...base} loading />);
    expect(container.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('renders the empty state when not loading and no data', () => {
    render(<PipelinePerformance {...base} loading={false} />);
    expect(screen.getByText('No performance data yet')).toBeInTheDocument();
  });

  it('renders execution, duration and bottleneck sections with data', () => {
    render(<PipelinePerformance loading={false} executions={[execRow]} durations={[duration]} bottlenecks={[bottleneck]} />);
    expect(screen.getByText('Pipeline Executions')).toBeInTheDocument();
    expect(screen.getByText('Pipeline Duration')).toBeInTheDocument();
    expect(screen.getByText('Stage Bottlenecks')).toBeInTheDocument();
    expect(screen.getByText('build')).toBeInTheDocument();
  });
});
