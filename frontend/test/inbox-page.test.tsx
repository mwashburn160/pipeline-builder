// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox aggregates independent sources. They load in parallel (one slow
 * source must not delay the others' requests), and a failing source only
 * drops its own items.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import InboxPage from '../pages/dashboard/inbox';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

const listAllPipelines = jest.fn<AnyFn>();
const getExecutionCount = jest.fn<AnyFn>();
const getExemptions = jest.fn<AnyFn>();
const getUnreadCount = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listAllPipelines: (...a: unknown[]) => listAllPipelines(...a),
    getExecutionCount: (...a: unknown[]) => getExecutionCount(...a),
    getExemptions: (...a: unknown[]) => getExemptions(...a),
    getUnreadCount: (...a: unknown[]) => getUnreadCount(...a),
  },
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('InboxPage', () => {
  beforeEach(() => {
    mockAuthGuard({ user: { id: 'me', organizationId: 'org-1' }, can: () => true });
  });

  it('requests every source in parallel, not one after another', async () => {
    const pipelines = deferred<unknown>();
    const exemptions = deferred<unknown>();
    const unread = deferred<unknown>();
    listAllPipelines.mockReturnValue(pipelines.promise);
    getExecutionCount.mockReturnValue(new Promise(() => {}));
    getExemptions.mockReturnValue(exemptions.promise);
    getUnreadCount.mockReturnValue(unread.promise);

    render(<InboxPage />);

    // Nothing has resolved yet, and all three sources are already in flight.
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalled());
    expect(listAllPipelines).toHaveBeenCalled();
    expect(getExemptions).toHaveBeenCalled();
  });

  it('shows the sources that loaded when another one fails', async () => {
    listAllPipelines.mockRejectedValue(new Error('pipeline service down'));
    getExecutionCount.mockResolvedValue({ success: true, data: { pipelines: [] } });
    getExemptions.mockResolvedValue({
      success: true,
      data: { exemptions: [{ id: 'ex1', entityType: 'plugin', reason: 'legacy build' }] },
    });
    getUnreadCount.mockResolvedValue({ success: true, data: { count: 2 } });

    render(<InboxPage />);

    expect(await screen.findByText('Exemption request pending review (plugin)')).toBeInTheDocument();
    expect(screen.getByText('2 unread messages')).toBeInTheDocument();
    expect(screen.queryByText(/could not load your action items/i)).not.toBeInTheDocument();
  });

  it('reports an error (not "Inbox zero") when every source fails', async () => {
    listAllPipelines.mockRejectedValue(new Error('down'));
    getExecutionCount.mockRejectedValue(new Error('down'));
    getExemptions.mockResolvedValue({ success: false });
    getUnreadCount.mockRejectedValue(new Error('down'));

    render(<InboxPage />);

    expect(await screen.findByText(/could not load your action items/i)).toBeInTheDocument();
    expect(screen.queryByText('Inbox zero')).not.toBeInTheDocument();
    await act(async () => {});
  });

  it('joins failures against EVERY owned pipeline (drained, ids only), not a capped page', async () => {
    listAllPipelines.mockResolvedValue([{ id: 'p-late' }]);
    getExecutionCount.mockResolvedValue({
      success: true,
      data: { pipelines: [{ id: 'p-late', pipeline_name: 'late', project: 'x', failed: 2, succeeded: 1, total: 3 }] },
    });
    getExemptions.mockResolvedValue({ success: true, data: { exemptions: [] } });
    getUnreadCount.mockResolvedValue({ success: true, data: { count: 0 } });

    render(<InboxPage />);

    expect(await screen.findByText('late has 2 failed runs')).toBeInTheDocument();
    expect(listAllPipelines).toHaveBeenCalledWith(['id'], { ownerId: 'me' }, expect.anything());
  });

  it('says how many pending exemptions it did not list', async () => {
    listAllPipelines.mockResolvedValue([]);
    getExecutionCount.mockResolvedValue({ success: true, data: { pipelines: [] } });
    getExemptions.mockResolvedValue({
      success: true,
      data: {
        exemptions: [{ id: 'ex1', entityType: 'plugin', reason: 'r' }],
        pagination: { total: 31, limit: 20, offset: 0, hasMore: true },
      },
    });
    getUnreadCount.mockResolvedValue({ success: true, data: { count: 0 } });

    render(<InboxPage />);

    const more = await screen.findByText('30 more exemption requests pending review');
    expect(more.closest('a')).toHaveAttribute('href', '/dashboard/compliance?view=exemptions');
    expect(getExemptions).toHaveBeenCalledWith({ status: 'pending', limit: 20, offset: 0 });
  });
});
