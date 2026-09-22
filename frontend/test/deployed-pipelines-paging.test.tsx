// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployed-pipelines registry pages through everything the server has. It
 * used to fetch 50 rows and stop — with the badge counting those 50 — so an org
 * past that could neither see nor reconcile its other deployments.
 */

import { it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const listPipelineRegistry = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({ __esModule: true, default: { listPipelineRegistry: (...a: unknown[]) => listPipelineRegistry(...a) } }));

import { DeployedPipelinesPanel } from '../src/components/pipeline/DeployedPipelinesPanel';

const row = (i: number) => ({ id: `r${i}`, pipelineId: `p${i}`, orgId: 'o', pipelineName: `pipe-${i}`, lastDeployed: new Date().toISOString(), createdAt: '', updatedAt: '' });

it('shows the server total and loads the next page on demand', async () => {
  listPipelineRegistry
    .mockResolvedValueOnce({ success: true, data: { registry: Array.from({ length: 50 }, (_, i) => row(i)), pagination: { total: 51, limit: 50, offset: 0, hasMore: true } } })
    .mockResolvedValueOnce({ success: true, data: { registry: [row(50)], pagination: { total: 51, limit: 50, offset: 50, hasMore: false } } });
  render(<DeployedPipelinesPanel />);
  fireEvent.click(screen.getByText('Deployed pipelines'));

  expect(await screen.findByText('Showing 50 of 51')).toBeInTheDocument();
  expect(screen.getByText('51')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(listPipelineRegistry).toHaveBeenLastCalledWith({ limit: 50, offset: 50 }));
  expect(await screen.findByText('pipe-50')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});
