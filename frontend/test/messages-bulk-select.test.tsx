// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Messages page: checkbox selection + bulk remove / delete, and the sender filter.
 *
 * A selection acts on the ticked ids only; "Remove all N" (nothing ticked) and
 * "Select all N" act on the server-side filter set; Delete is ticked-rows-only
 * and only when every one is the viewer's own root message.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import MessagesPage from '../pages/dashboard/messages';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/RecentlyDeletedPanel', () => ({ __esModule: true, RecentlyDeletedPanel: () => null }));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ organizations: [] })));
jest.mock('@/hooks/useFeatures', () => ({ __esModule: true, useFeatures: () => ({ supportAlias: 'support@x.io', supportAliases: [] }) }));
jest.mock('@/hooks/useMessageNotifications', () => ({
  __esModule: true,
  useMessageNotifications: () => ({ unreadCount: 0, connected: false, everConnected: false, onNotification: () => () => {} }),
}));
jest.mock('@/hooks/usePolling', () => ({ __esModule: true, usePolling: () => {} }));
// The thread panel's own fetches are out of scope — render the subject it was handed.
jest.mock('@/components/message/ThreadView', () => ({
  __esModule: true,
  ThreadView: ({ rootMessage }: { rootMessage: { subject: string } }) => <div data-testid="thread">{rootMessage.subject}</div>,
}));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/messages', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const getMessages = jest.fn<AnyFn>();
const getMessage = jest.fn<AnyFn>();
const markMessageAsRead = jest.fn<AnyFn>();
const hideMessages = jest.fn<AnyFn>();
const deleteMessage = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getMessages: (...a: unknown[]) => getMessages(...a),
    getMessage: (...a: unknown[]) => getMessage(...a),
    markMessageAsRead: (...a: unknown[]) => markMessageAsRead(...a),
    hideMessages: (...a: unknown[]) => hideMessages(...a),
    deleteMessage: (...a: unknown[]) => deleteMessage(...a),
    getUnreadCount: () => Promise.resolve({ data: { count: 0 } }),
  },
}));


/** Two received + one I sent (a root, so mine to delete). */
const rows = [
  { id: 'm-1', subject: 'Invoice ready', content: 'first body', orgId: 'org-2', recipientOrgId: 'org-1', createdBy: 'u9', threadId: null, messageType: 'conversation', createdAt: '2026-01-03T00:00:00Z', readBy: {} },
  { id: 'm-2', subject: 'Outage notice', content: 'second body', orgId: 'org-2', recipientOrgId: 'org-1', createdBy: 'u9', threadId: null, messageType: 'conversation', createdAt: '2026-01-02T00:00:00Z', readBy: { 'org-1': 'x' } },
  { id: 'm-3', subject: 'My question', content: 'third body', orgId: 'org-1', recipientOrgId: 'org-2', createdBy: 'u1', threadId: null, messageType: 'conversation', createdAt: '2026-01-01T00:00:00Z', readBy: {} },
];
const page = (messages: unknown[], total = messages.length) =>
  ({ data: { messages, pagination: { total, limit: 25, offset: 0, hasMore: total > messages.length } } });

beforeEach(() => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  mockRouter.query = {};
  getMessages.mockReset().mockResolvedValue(page(rows));
  getMessage.mockReset();
  markMessageAsRead.mockReset().mockResolvedValue({ success: true });
  hideMessages.mockReset().mockResolvedValue({ data: { hidden: 2 } });
  deleteMessage.mockReset().mockResolvedValue({ success: true });
});

const tick = (subject: string) => fireEvent.click(screen.getByLabelText(`Select message: ${subject}`));

describe('inbox bulk selection', () => {
  it('ticking a row selects it WITHOUT opening it', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('Invoice ready');

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();
    expect(markMessageAsRead).not.toHaveBeenCalled();
  });

  it('removes ONLY the ticked rows, by id', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('Invoice ready');
    tick('Outage notice');
    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    expect(await screen.findByText(/2 selected messages/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!);

    await waitFor(() => expect(hideMessages).toHaveBeenCalledWith({ ids: ['m-1', 'm-2'] }));
  });

  it('with nothing ticked, "Remove all N" acts on the active filters', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    fireEvent.change(screen.getByLabelText('Filter by read state'), { target: { value: 'read' } });
    fireEvent.change(screen.getByLabelText('Filter by sender'), { target: { value: 'others' } });
    await waitFor(() => expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({ isRead: true, sentBy: 'others' })));

    fireEvent.click(await screen.findByRole('button', { name: /Remove all 3/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(hideMessages).toHaveBeenCalledWith({ isRead: true, sentBy: 'others' }));
  });

  it('"Select all N" escalates a full page to every match on the server', async () => {
    getMessages.mockResolvedValue(page(rows, 40));
    render(<MessagesPage />);
    await screen.findByText('first body');

    fireEvent.click(screen.getByLabelText('Select all loaded messages'));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 40' }));
    expect(screen.getByText('All 40 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!);
    // Filters, not ids — the 37 unloaded rows are included.
    await waitFor(() => expect(hideMessages).toHaveBeenCalledWith({}));
  });

  it('changing a filter drops the selection', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');
    tick('Invoice ready');

    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: 'high' } });

    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
  });

  it('Delete is disabled once the selection includes a message the viewer did not send', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('My question');
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeEnabled();

    tick('Invoice ready');
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeDisabled();
  });

  it('deletes the ticked own messages one by one after confirming', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('My question');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await screen.findByText(/1 selected message and their replies/);
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/ }).at(-1)!);

    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith('m-3'));
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });
});
