// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Messages page: the `?message=<id>` deep link and the server-side filters.
 *
 * The deep link must open a message that is NOT on the loaded inbox page — it
 * is fetched through `GET /messages/:id` — and the read/priority/channel
 * filters must reach the server instead of narrowing the loaded page.
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
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => ({ organizations: [] }) }));
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
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

const getMessages = jest.fn<AnyFn>();
const getMessage = jest.fn<AnyFn>();
const markMessageAsRead = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getMessages: (...a: unknown[]) => getMessages(...a),
    getMessage: (...a: unknown[]) => getMessage(...a),
    markMessageAsRead: (...a: unknown[]) => markMessageAsRead(...a),
    getUnreadCount: () => Promise.resolve({ data: { count: 0 } }),
  },
}));

const linked = {
  id: 'm-old', subject: 'Linked from an email', content: 'body', orgId: 'org-2', recipientOrgId: 'org-1',
  messageType: 'conversation', createdAt: '2026-01-01T00:00:00Z', readBy: {},
};

beforeEach(() => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  mockRouter.query = {};
  mockRouter.replace.mockClear();
  getMessages.mockReset().mockResolvedValue({ data: { messages: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } });
  getMessage.mockReset();
  markMessageAsRead.mockReset().mockResolvedValue({ success: true });
});

describe('message deep link', () => {
  it('opens a message that is not on the loaded page by fetching it by id', async () => {
    mockRouter.query = { message: 'm-old' };
    getMessage.mockResolvedValue({ success: true, data: { message: linked } });

    render(<MessagesPage />);

    expect(await screen.findByTestId('thread')).toHaveTextContent('Linked from an email');
    expect(getMessage).toHaveBeenCalledWith('m-old', expect.objectContaining({ signal: expect.any(Object) }));
    // Opening it marks it read for the viewer's org, same as a click.
    await waitFor(() => expect(markMessageAsRead).toHaveBeenCalledWith('m-old'));
  });

  it('says so when the linked message is not visible to the viewer', async () => {
    mockRouter.query = { message: 'm-gone' };
    getMessage.mockResolvedValue({ success: false, statusCode: 404, message: 'Message not found.' });

    render(<MessagesPage />);

    expect(await screen.findByText(/could not be found/i)).toBeInTheDocument();
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();
  });

  it('writes the open message into the URL when one is picked from the list', async () => {
    getMessages.mockResolvedValue({ data: { messages: [linked], pagination: { total: 1, limit: 25, offset: 0, hasMore: false } } });

    render(<MessagesPage />);
    // The row previews the content; its unread dot carries an sr-only label.
    const row = (await screen.findByText('body')).closest('[role="button"]') as HTMLElement;
    expect(row).toHaveTextContent('Unread');
    fireEvent.click(row);

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ message: 'm-old' }) }),
      undefined,
      { shallow: true },
    ));
  });
});

describe('message filters', () => {
  it('sends read-state, priority and channel to the server', async () => {
    render(<MessagesPage />);
    await waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Filter by read state'), { target: { value: 'unread' } });
    await waitFor(() => expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({ isRead: false })));

    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: 'urgent' } });
    fireEvent.change(screen.getByLabelText('Filter by channel'), { target: { value: 'support' } });
    await waitFor(() => expect(getMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ isRead: false, priority: 'urgent', channel: 'support', offset: 0 }),
    ));
  });
});
