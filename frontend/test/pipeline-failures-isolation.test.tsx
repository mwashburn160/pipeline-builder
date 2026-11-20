// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the extracted PipelineFailures tab: the loading skeleton,
 * the no-data empty state, and the data render (stage failures, action failures,
 * and the top-errors grid — now keyed by error_pattern).
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { PipelineFailures } from '../src/components/reports/PipelineFailures';
import type { StageFailure, ActionFailure, ErrorEntry } from '../src/components/reports/types';

const stage: StageFailure = { pipeline_id: 'p-api', pipeline_name: 'api', stage_name: 'deploy', failures: 3, total: 10, failure_pct: 30 };
const action: ActionFailure = { pipeline_id: 'p-api', pipeline_name: 'api', stage_name: 'deploy', action_name: 'terraform-apply', failures: 2, total: 5, failure_pct: 40 };
const error: ErrorEntry = { error_pattern: 'timeout waiting for lock', occurrences: 4, affected_pipelines: 2, last_seen: '2026-07-20T00:00:00.000Z' };

const base = { stageFailures: [] as StageFailure[], actionFailures: [] as ActionFailure[], errors: [] as ErrorEntry[] };

describe('PipelineFailures (isolation)', () => {
  it('renders the skeleton while loading with no data', () => {
    const { container } = render(<PipelineFailures {...base} loading />);
    expect(container.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('renders the empty state when not loading and no data', () => {
    render(<PipelineFailures {...base} loading={false} />);
    expect(screen.getByText('No failure data')).toBeInTheDocument();
  });

  it('renders stage, action and error sections with data', () => {
    render(<PipelineFailures loading={false} stageFailures={[stage]} actionFailures={[action]} errors={[error]} />);
    expect(screen.getByText('Stage failures')).toBeInTheDocument();
    expect(screen.getByText('deploy')).toBeInTheDocument();
    expect(screen.getByText('Action failures')).toBeInTheDocument();
    expect(screen.getByText('terraform-apply')).toBeInTheDocument();
    expect(screen.getByText('Top errors (all organizations)')).toBeInTheDocument();
    expect(screen.getByText('timeout waiting for lock')).toBeInTheDocument();
  });

  it('same-named stages in two pipelines are two rows, each linking to ITS pipeline\'s runs', () => {
    const web: StageFailure = { pipeline_id: 'p-web', pipeline_name: 'web', stage_name: 'deploy', failures: 0, total: 4, failure_pct: 0 };
    render(<PipelineFailures loading={false} stageFailures={[stage, web]} actionFailures={[action]} errors={[]} showErrors={false} />);
    expect(screen.getAllByText('deploy')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'api' })).toHaveAttribute('href', '/dashboard/pipelines/p-api?tab=runs');
    expect(screen.getByRole('link', { name: 'web' })).toHaveAttribute('href', '/dashboard/pipelines/p-web?tab=runs');
    expect(screen.getByText('3/10 (30%)')).toBeInTheDocument();
    // The action row names its pipeline and stage, and links there too.
    expect(screen.getByRole('link', { name: 'api / deploy' })).toHaveAttribute('href', '/dashboard/pipelines/p-api?tab=runs');
  });
});
