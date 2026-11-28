// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline Runs tab on a phone: the execution history is a stacked list of
 * run cards, not a seven-column table — so a run's status, its failure and its
 * Cancel are on screen without scrolling the table sideways. A desktop keeps
 * the table.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { mockViewport, resetViewport } from './helpers/viewport';
import { PipelineRunsTab } from '../src/components/pipeline/detail/PipelineRunsTab';
import type { PipelineExecution } from '../src/components/pipeline/detail/pipeline-detail-model';

const exec = (id: string, status: string, extra: Partial<PipelineExecution> = {}): PipelineExecution => ({
  execution_id: id, status, started_at: '2026-11-10T00:00:00Z', ended_at: null, duration_ms: 65_000,
  failing_stage: null, failing_action: null, ...extra,
});

function renderRuns(onCancel = jest.fn<AnyFn>()) {
  render(
    <PipelineRunsTab
      data={{
        execCounts: { data: null, error: null, loading: false, refetch: jest.fn<AnyFn>() } as never,
        execStats: null,
        executions: [
          exec('exec-0123456789abcdef-running', 'in-progress'),
          exec('exec-failed', 'failed', { failing_stage: 'Deploy', failure: { code: 'BUILD_FAILED', message: 'tests failed' } as never }),
        ],
        execLoading: false,
        execError: null,
        loadExecutions: jest.fn<AnyFn>() as never,
        toolchainChange: null,
        toolchainMarkerRunId: null,
      }}
      canEdit
      canceling={false}
      cancelTarget={null}
      onCancel={onCancel}
    />,
  );
  return onCancel;
}

afterEach(() => resetViewport());

describe('Runs tab on a phone (390px)', () => {
  it('lists each run as a card with its status, failure, copyable id and Cancel — no table', () => {
    mockViewport(390);
    const onCancel = renderRuns();

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const runs = screen.getAllByRole('listitem', { name: /^Run / });
    expect(runs).toHaveLength(2);

    const running = runs[0]!;
    expect(within(running).getByText('in-progress')).toBeInTheDocument();
    expect(within(running).getByText('exec-0123456789abcdef-running')).toBeInTheDocument();
    expect(within(running).getByRole('button', { name: /copy/i })).toBeInTheDocument();
    fireEvent.click(within(running).getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledWith('exec-0123456789abcdef-running');

    const failed = runs[1]!;
    expect(within(failed).getByText('Deploy')).toBeInTheDocument();
    expect(within(failed).getByText('BUILD_FAILED')).toBeInTheDocument();
    expect(within(failed).getByTestId('execution-failure-exec-failed')).toHaveTextContent('tests failed');
    expect(within(failed).queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument();
  });
});

describe('Runs tab on a desktop', () => {
  it('keeps the execution table', () => {
    renderRuns();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem', { name: /^Run / })).toHaveLength(0);
  });
});
