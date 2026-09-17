// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox aggregates independent sources. They load in parallel (one slow
 * source must not delay the others' requests), and a failing source only
 * drops its own items.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import InboxPage from '../pages/dashboard/inbox';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

const listPipelines = jest.fn();
const getExecutionCount = jest.fn();
const getExemptions = jest.fn();
const getUnreadCount = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listPipelines: (...a: unknown[]) => listPipelines(...a),
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
    listPipelines.mockReturnValue(pipelines.promise);
    getExecutionCount.mockReturnValue(new Promise(() => {}));
    getExemptions.mockReturnValue(exemptions.promise);
    getUnreadCount.mockReturnValue(unread.promise);

    render(<InboxPage />);

    // Nothing has resolved yet, and all three sources are already in flight.
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalled());
    expect(listPipelines).toHaveBeenCalled();
    expect(getExemptions).toHaveBeenCalled();
  });

  it('shows the sources that loaded when another one fails', async () => {
    listPipelines.mockRejectedValue(new Error('pipeline service down'));
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
    listPipelines.mockRejectedValue(new Error('down'));
    getExecutionCount.mockRejectedValue(new Error('down'));
    getExemptions.mockResolvedValue({ success: false });
    getUnreadCount.mockRejectedValue(new Error('down'));

    render(<InboxPage />);

    expect(await screen.findByText(/could not load your action items/i)).toBeInTheDocument();
    expect(screen.queryByText('Inbox zero')).not.toBeInTheDocument();
    await act(async () => {});
  });
});
