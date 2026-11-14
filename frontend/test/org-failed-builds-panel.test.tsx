// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org-facing "Failed builds" tab of the plugins page: the tenant view of
 * `GET /plugins/queue/failed` + `/dlq` (server-scoped to the caller's org, no
 * `total`) with Retry / Replay behind a confirm.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { pageToast } from './helpers/pageMocks';
import { ApiError } from '../src/lib/api/errors';
import { OrgFailedBuildsPanel } from '../src/components/plugin/OrgFailedBuildsPanel';
import { toServerPage } from '../src/components/build-queue/server-page';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const api = {
  getQueueFailed: jest.fn<AnyFn>(),
  getQueueDlq: jest.fn<AnyFn>(),
  retryFailedJob: jest.fn<AnyFn>(),
  replayDlqJob: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });
/** A tenant page: no `total`, `hasMore` drives paging. */
const tenantPage = (jobs: unknown[], hasMore = false) => ok({ jobs, pagination: { limit: 25, offset: 0, hasMore } });

const FAILED = { id: 'job-failed-1234567', pluginName: 'rust', error: 'exit 1', attemptsMade: 3, maxAttempts: 3, failedAt: '2026-11-01T00:00:00Z', contextAvailable: true };
const DEAD = { id: 'job-dead-7654321', pluginName: 'go', lastError: 'registry timeout', failureCategory: 'transient', attemptsMade: 5, maxAttempts: 5, failedAt: '2026-11-01T00:00:00Z' };


beforeEach(() => {
  jest.clearAllMocks();
  api.getQueueFailed.mockImplementation(() => tenantPage([FAILED]));
  api.getQueueDlq.mockImplementation(() => tenantPage([DEAD]));
  api.retryFailedJob.mockImplementation(() => ok({ retried: true, newJobId: 'new-1' }));
  api.replayDlqJob.mockImplementation(() => ok({ replayed: true, newJobId: 'new-2' }));
});

describe('OrgFailedBuildsPanel', () => {
  it("lists the org's failed and dead-lettered builds, the DLQ reason in the error column", async () => {
    render(<OrgFailedBuildsPanel />);
    expect(await screen.findByText('rust')).toBeInTheDocument();
    expect(await screen.findByText('go')).toBeInTheDocument();
    expect(screen.getByText('registry timeout')).toBeInTheDocument();
    expect(screen.getByTestId('org-failed-builds')).toHaveTextContent("your organization's");
  });

  it('says so when the viewer is a queue operator who sees every org', async () => {
    render(<OrgFailedBuildsPanel seesEveryOrg />);
    await screen.findByText('go');
    expect(screen.getByTestId('org-failed-builds')).toHaveTextContent("every organization's");
  });

  it('Retry confirms, re-enqueues, toasts the new job and re-reads the failed list', async () => {
    render(<OrgFailedBuildsPanel />);
    await screen.findByText('rust');
    const reads = api.getQueueFailed.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('job-failed-1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry build' }));
    await waitFor(() => expect(api.retryFailedJob).toHaveBeenCalledWith(FAILED.id));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Re-enqueued as job new-1'));
    await waitFor(() => expect(api.getQueueFailed.mock.calls.length).toBeGreaterThan(reads));
    expect(api.replayDlqJob).not.toHaveBeenCalled();
  });

  it('Replay confirms and re-enqueues a dead-lettered build', async () => {
    render(<OrgFailedBuildsPanel />);
    await screen.findByText('go');
    const reads = api.getQueueDlq.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(api.replayDlqJob).toHaveBeenCalledWith(DEAD.id));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Re-enqueued as job new-2'));
    await waitFor(() => expect(api.getQueueDlq.mock.calls.length).toBeGreaterThan(reads));
  });

  it('a 404 (already retried, or no longer visible) says the list is stale and re-reads it', async () => {
    api.retryFailedJob.mockImplementation(() => Promise.reject(new ApiError('Failed job x not found', 404, 'NOT_FOUND')));
    render(<OrgFailedBuildsPanel />);
    await screen.findByText('rust');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry build' }));
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith('That build is no longer in the queue — the list has been refreshed.'));
  });

  it('any other refusal (e.g. 429 at the build quota) shows the server message', async () => {
    api.replayDlqJob.mockImplementation(() => Promise.reject(new ApiError('The organization is at its plugin build quota; the build was not re-queued.', 429, 'QUOTA_EXCEEDED')));
    render(<OrgFailedBuildsPanel />);
    await screen.findByText('go');
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith(expect.stringMatching(/plugin build quota/)));
  });

  it('a non-ApiError failure falls back to the kind-specific message', async () => {
    api.retryFailedJob.mockImplementation(() => Promise.reject({}));
    render(<OrgFailedBuildsPanel />);
    await screen.findByText('rust');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry build' }));
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith('Failed to retry build'));
  });

  it('Cancel closes the confirm without calling the API', async () => {
    render(<OrgFailedBuildsPanel />);
    await screen.findByText('rust');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.retryFailedJob).not.toHaveBeenCalled();
  });

  it('a failed read is an error with Retry, never an empty list', async () => {
    api.getQueueFailed.mockImplementation(() => Promise.reject(new Error('queue down')));
    api.getQueueDlq.mockImplementation(() => Promise.reject(new Error('dlq down')));
    render(<OrgFailedBuildsPanel />);
    expect(await screen.findByText('queue down')).toBeInTheDocument();
    expect(await screen.findByText('dlq down')).toBeInTheDocument();
  });
});

describe('toServerPage', () => {
  it('uses the exact total when the server gives one', () => {
    expect(toServerPage([1, 2], { total: 9, limit: 2, offset: 0, hasMore: true }, 0, 2).pagination).toEqual({ offset: 0, limit: 2, total: 9 });
  });
  it('without a total (tenant), offers one more page while hasMore', () => {
    expect(toServerPage([1, 2], { limit: 2, offset: 2, hasMore: true }, 2, 2).pagination.total).toBe(5);
    expect(toServerPage([1], { limit: 2, offset: 2, hasMore: false }, 2, 2).pagination.total).toBe(3);
  });
  it('an absent page is empty at the requested offset', () => {
    expect(toServerPage(undefined, undefined, 4, 10)).toEqual({ items: [], pagination: { offset: 4, limit: 10, total: 4 } });
  });
});
