// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The build-queue tables are paged SERVER-side: the page asks for one
 * limit/offset window at a time and renders the server's total, instead of
 * pulling every failed job into the browser and slicing it there.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import BuildQueuePage from '../pages/dashboard/build-queue';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/usePolling', () => ({ __esModule: true, usePolling: () => {} }));

const getQueueStatus = jest.fn();
const getQueueFailed = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getQueueStatus: (...a: unknown[]) => getQueueStatus(...a),
    getQueueFailed: (...a: unknown[]) => getQueueFailed(...a),
    getQueueDlq: () => Promise.resolve({ data: { jobs: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } }),
  },
}));

const job = (i: number) => ({ id: `job-${i}`, pluginName: `plugin-${i}`, failedAt: '2026-01-01T00:00:00Z' });

beforeEach(() => {
  mockAuthGuard({ isSuperAdmin: true, isAdmin: true, user: { id: 'op', organizationId: 'system' } });
  getQueueStatus.mockResolvedValue({
    data: { waiting: 0, active: 0, completed: 0, failed: 60, delayed: 0, dlq: { waiting: 0, active: 0, failed: 0, delayed: 0 } },
  });
  getQueueFailed.mockReset().mockImplementation(({ offset, limit }: { offset: number; limit: number }) => Promise.resolve({
    data: {
      jobs: Array.from({ length: Math.min(limit, 60 - offset) }, (_, i) => job(offset + i)),
      pagination: { total: 60, limit, offset, hasMore: offset + limit < 60 },
    },
  }));
});

it('reads failed jobs one server page at a time', async () => {
  render(<BuildQueuePage />);
  expect(getQueueFailed).not.toHaveBeenCalled(); // not until the operator opens the table

  fireEvent.click(await screen.findByRole('button', { name: 'View Failed Jobs' }));
  await waitFor(() => expect(getQueueFailed).toHaveBeenLastCalledWith({ offset: 0, limit: 25 }, expect.anything()));
  expect(await screen.findByText('plugin-0')).toBeInTheDocument();
  expect(screen.getByText(/of 60/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /next page/i }));
  await waitFor(() => expect(getQueueFailed).toHaveBeenLastCalledWith({ offset: 25, limit: 25 }, expect.anything()));
  expect(await screen.findByText('plugin-25')).toBeInTheDocument();
  expect(screen.queryByText('plugin-0')).not.toBeInTheDocument();
});
