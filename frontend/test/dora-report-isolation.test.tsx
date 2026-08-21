// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the DoraReport component (the DORA tab body, extracted from
 * PipelineOverview). Covers the scope-control wiring + the environment datalist.
 * The page-level fetch/tab wiring is covered by dora-section.test.tsx.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DoraReport } from '../src/components/reports/DoraReport';
import type { ExecutionCountRow } from '../src/types';
import type { DoraMetrics } from '../src/lib/api/domains/reporting';

const execRow: ExecutionCountRow = {
  id: 'p1', project: 'Proj', organization: 'org-1', pipeline_name: 'Pipe One',
  total: 10, succeeded: 8, failed: 2, canceled: 0, first_execution: null, last_execution: null,
};

const doraScope = {
  pipelineId: '', environment: '',
  onPipelineChange: jest.fn(), onEnvironmentChange: jest.fn(),
  onEnvironmentCommit: jest.fn(),
};

const baseProps = {
  loading: false,
  dora: null,
  doraTrend: [],
  pipelineOptions: [] as { id: string; name: string }[],
  executions: [] as ExecutionCountRow[],
  environmentOptions: [] as string[],
  deployments: [],
  deployPipelineSelected: false,
  markEnvironment: 'production',
  canMark: true,
  onMarkOutcome: jest.fn().mockResolvedValue(undefined),
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

const doraWithData: DoraMetrics = {
  window: { from: '2026-06-27T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' },
  filters: { pipelineId: 'p1', environment: null },
  headline: 'production',
  environments: [
    {
      environment: 'production',
      deploymentFrequency: { deployments: 4, perDay: 0.13 },
      leadTime: { deployments: 4, medianSeconds: 300, level: 'elite' },
      changeFailureRate: { rate: 25, deployTimeFailures: 1, postDeployFailures: 0, attempts: 4, level: 'medium' },
    },
  ],
  meanTimeToRestore: { medianSeconds: null, incidents: 0, restored: 0 },
  coverage: { registered: 2, deploying: 1, withoutDeploys: 0 },
};

const deployRow = {
  execution_id: 'exec-9', status: 'Succeeded',
  started_at: '2026-07-20T00:00:00.000Z', ended_at: '2026-07-20T00:05:00.000Z',
  duration_ms: 300000, failing_stage: null, failing_action: null,
};

describe('DoraReport — headline fallback + retention truncation', () => {
  it('falls back to the "no deploy-attributed environments" empty state when environments is empty', () => {
    render(
      <DoraReport
        {...baseProps}
        dora={{ ...doraWithData, environments: [] }}
      />,
    );
    // The scope controls + heading stay; the metric cards do not render.
    expect(screen.getByText('DORA Metrics')).toBeInTheDocument();
    expect(screen.getByText(/No deploy-attributed environments in this window/i)).toBeInTheDocument();
    expect(screen.queryByText('Deployment Frequency')).not.toBeInTheDocument();
  });

  it('shows a truncation banner + Extend history CTA when the window was floored past the requested from', () => {
    // Requested from Jan 1, but the effective window starts Jun 27 → truncated.
    render(
      <DoraReport
        {...baseProps}
        dora={doraWithData}
        requestedFrom="2026-01-01"
      />,
    );
    expect(screen.getByText(/limited by your DORA retention/i)).toBeInTheDocument();
    // Window is Jun 27 → Jul 27 = 30 days.
    expect(screen.getByText(/Showing the last/i)).toHaveTextContent('30 days');
    const cta = screen.getByRole('link', { name: /extend history/i });
    expect(cta).toHaveAttribute('href', expect.stringContaining('highlight=dora_history_pack'));
  });

  it('does NOT show the truncation banner when the window matches the request', () => {
    render(
      <DoraReport
        {...baseProps}
        dora={doraWithData}
        requestedFrom="2026-06-27"
      />,
    );
    expect(screen.queryByText(/limited by your DORA retention/i)).not.toBeInTheDocument();
  });
});

describe('DoraReport — deploy list (mark failed/restored)', () => {
  it('prompts to pick a pipeline when none is scoped', () => {
    render(<DoraReport {...baseProps} dora={doraWithData} deployPipelineSelected={false} />);
    expect(screen.getByText(/Select a pipeline to list its deployments/i)).toBeInTheDocument();
  });

  it('lists deployments and fires onMarkOutcome from the row actions', async () => {
    const onMarkOutcome = jest.fn().mockResolvedValue(undefined);
    render(
      <DoraReport
        {...baseProps}
        dora={doraWithData}
        deployments={[deployRow]}
        deployPipelineSelected
        markEnvironment="production"
        onMarkOutcome={onMarkOutcome}
      />,
    );
    expect(screen.getByText('exec-9')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /mark failed/i }));
    await waitFor(() => expect(onMarkOutcome).toHaveBeenCalledWith('exec-9', 'failed'));

    fireEvent.click(screen.getByRole('button', { name: /mark restored/i }));
    await waitFor(() => expect(onMarkOutcome).toHaveBeenCalledWith('exec-9', 'restored'));
  });

  it('hides the mark actions when the viewer lacks permission (canMark=false)', () => {
    render(
      <DoraReport
        {...baseProps}
        dora={doraWithData}
        deployments={[deployRow]}
        deployPipelineSelected
        canMark={false}
      />,
    );
    expect(screen.getByText('exec-9')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark failed/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark restored/i })).not.toBeInTheDocument();
  });
});
