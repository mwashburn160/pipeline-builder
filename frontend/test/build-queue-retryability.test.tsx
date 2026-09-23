// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A build that gave up has had its context deleted (the terminal failure path
 * drops the local scratch dir AND the staged object), so re-enqueuing it can
 * only die in `ensureLocalBuildContext` with "Build context missing" — an error
 * that reads like data loss rather than "this one needs uploading again".
 *
 * So the row must not offer Retry once the server reports the context gone.
 * The DLQ table omits the field entirely, and replay there sources differently,
 * so an ABSENT value has to keep the button.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import BuildQueuePage from '../pages/dashboard/build-queue';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/usePolling', () => ({ __esModule: true, usePolling: () => {} }));

const getQueueStatus = jest.fn<AnyFn>();
const getQueueFailed = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getQueueStatus: (...a: unknown[]) => getQueueStatus(...a),
    getQueueFailed: (...a: unknown[]) => getQueueFailed(...a),
    getQueueDlq: () => Promise.resolve({ data: { jobs: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } }),
  },
}));

const page = (jobs: unknown[]) => Promise.resolve({
  data: { jobs, pagination: { total: jobs.length, limit: 25, offset: 0, hasMore: false } },
});

beforeEach(() => {
  mockAuthGuard({ isSuperAdmin: true, isAdmin: true, user: { id: 'op', organizationId: 'system' } });
  getQueueStatus.mockResolvedValue({
    data: { waiting: 0, active: 0, completed: 0, failed: 2, delayed: 0, dlq: { waiting: 0, active: 0, failed: 0, delayed: 0 } },
  });
  getQueueFailed.mockReset();
});

it('offers Retry while the build context is still there', async () => {
  getQueueFailed.mockImplementation(() => page([
    { id: 'job-1', pluginName: 'rust', failedAt: '2026-01-01T00:00:00Z', contextAvailable: true },
  ]));
  render(<BuildQueuePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'View Failed Jobs' }));
  expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
});

it('replaces Retry with re-upload guidance once the context is gone', async () => {
  getQueueFailed.mockImplementation(() => page([
    { id: 'job-1', pluginName: 'rust', failedAt: '2026-01-01T00:00:00Z', contextAvailable: false },
  ]));
  render(<BuildQueuePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'View Failed Jobs' }));

  expect(await screen.findByText(/re-upload to rebuild/i)).toBeInTheDocument();
  // The button is GONE, not merely disabled: a disabled Retry still reads as
  // "try later", and no amount of waiting brings a deleted context back.
  await waitFor(() => expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument());
});

it('keeps Retry when the server does not report the field (DLQ replay path)', async () => {
  getQueueFailed.mockImplementation(() => page([
    { id: 'job-1', pluginName: 'rust', failedAt: '2026-01-01T00:00:00Z' },
  ]));
  render(<BuildQueuePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'View Failed Jobs' }));
  expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
});
