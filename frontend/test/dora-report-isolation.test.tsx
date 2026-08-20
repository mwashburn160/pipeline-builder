// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the DoraReport component (the DORA tab body, extracted from
 * PipelineOverview). Covers the scope-control wiring + the environment datalist.
 * The page-level fetch/tab wiring is covered by dora-section.test.tsx.
 */

import { render, screen } from '@testing-library/react';
import { DoraReport } from '../src/components/reports/DoraReport';
import type { ExecutionCountRow } from '../src/types';

const execRow: ExecutionCountRow = {
  id: 'p1', project: 'Proj', organization: 'org-1', pipeline_name: 'Pipe One',
  total: 10, succeeded: 8, failed: 2, canceled: 0, first_execution: null, last_execution: null,
};

const doraScope = {
  pipelineId: '', environment: '', deploysOnly: false,
  onPipelineChange: jest.fn(), onEnvironmentChange: jest.fn(),
  onEnvironmentCommit: jest.fn(), onDeploysOnlyChange: jest.fn(),
};

const baseProps = {
  loading: false,
  dora: null,
  doraTrend: [],
  pipelineOptions: [] as { id: string; name: string }[],
  executions: [] as ExecutionCountRow[],
  environmentOptions: [] as string[],
  doraScope,
};

describe('DoraReport (isolation)', () => {
  it('renders the scope controls (heading + pipeline/environment filters)', () => {
    render(<DoraReport {...baseProps} executions={[execRow]} />);
    expect(screen.getByText('DORA Metrics')).toBeInTheDocument();
    expect(screen.getByLabelText(/filter dora by pipeline/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/filter dora by environment/i)).toBeInTheDocument();
  });

  it('seeds the environment datalist with defaults merged with observed environments (deduped)', () => {
    const { container } = render(
      <DoraReport {...baseProps} executions={[execRow]} environmentOptions={['prod-eu', 'production']} />,
    );
    const options = [...container.querySelectorAll('#dora-environments option')].map((o) => o.getAttribute('value'));
    // Observed first, then defaults; "production" appears once (case-insensitive dedup).
    expect(options[0]).toBe('prod-eu');
    expect(options).toContain('staging');
    expect(options.filter((v) => v?.toLowerCase() === 'production')).toHaveLength(1);
  });

  it('shows the empty state when there is no DORA data for the scope', () => {
    render(<DoraReport {...baseProps} />);
    expect(screen.getByText('No DORA data for this scope')).toBeInTheDocument();
  });
});
