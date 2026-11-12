// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Messages page: checkbox selection + bulk actions, the sender / counterparty
 * / removed filters, and the URL mirror of all of it.
 *
 * A selection acts on the ticked ids only; "Remove all N" (nothing ticked) and
 * "Select all N" act on the server-side filter set; Delete / Read / Unread /
 * Restore are ticked-rows-only, and Delete only when every row is the viewer's
 * own root message. A removal of ticked rows can be undone from its toast.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
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
const unhideMessages = jest.fn<AnyFn>();
const setMessagesReadState = jest.fn<AnyFn>();
const deleteMessages = jest.fn<AnyFn>();
const getOrganizationMembers = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getMessages: (...a: unknown[]) => getMessages(...a),
    getMessage: (...a: unknown[]) => getMessage(...a),
    markMessageAsRead: (...a: unknown[]) => markMessageAsRead(...a),
    hideMessages: (...a: unknown[]) => hideMessages(...a),
    unhideMessages: (...a: unknown[]) => unhideMessages(...a),
    setMessagesReadState: (...a: unknown[]) => setMessagesReadState(...a),
    deleteMessages: (...a: unknown[]) => deleteMessages(...a),
    getOrganizationMembers: (...a: unknown[]) => getOrganizationMembers(...a),
    getUnreadCount: () => Promise.resolve({ data: { count: 0 } }),
  },
}));


/** Two received + one I sent (a root, so mine to delete). */
const rows = [
  { id: 'm-1', subject: 'Invoice ready', content: 'first body', orgId: 'org-2', orgName: 'Acme', recipientOrgId: 'org-1', createdBy: 'u9', threadId: null, messageType: 'conversation', createdAt: '2026-01-03T00:00:00Z', readBy: {} },
  { id: 'm-2', subject: 'Outage notice', content: 'second body', orgId: 'org-2', orgName: 'Acme', recipientOrgId: 'org-1', createdBy: 'u9', threadId: null, messageType: 'conversation', createdAt: '2026-01-02T00:00:00Z', readBy: { 'org-1': 'x' } },
  { id: 'm-3', subject: 'My question', content: 'third body', orgId: 'org-1', recipientOrgId: 'org-2', recipientOrgName: 'Acme', createdBy: 'u1', threadId: null, messageType: 'conversation', createdAt: '2026-01-01T00:00:00Z', readBy: {} },
];
const page = (messages: unknown[], total = messages.length) =>
  ({ data: { messages, pagination: { total, limit: 25, offset: 0, hasMore: total > messages.length } } });

beforeEach(() => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  mockRouter.query = {};
  mockRouter.replace.mockClear();
  getMessages.mockReset().mockResolvedValue(page(rows));
  getMessage.mockReset();
  markMessageAsRead.mockReset().mockResolvedValue({ success: true });
  hideMessages.mockReset().mockResolvedValue({ data: { hidden: 2 } });
  unhideMessages.mockReset().mockResolvedValue({ data: { restored: 2 } });
  setMessagesReadState.mockReset().mockResolvedValue({ data: { updated: 2 } });
  deleteMessages.mockReset().mockResolvedValue({ data: { deleted: ['m-3'], notFound: [], refused: [] } });
  getOrganizationMembers.mockReset().mockResolvedValue({ data: { members: [{ id: 'u5', username: 'dana', email: 'd@x.io' }] } });
  pageToast.success.mockClear();
  pageToast.error.mockClear();
});

const tick = (subject: string, init?: { shiftKey?: boolean }) =>
  fireEvent.click(screen.getByLabelText(`Select message: ${subject}`), init);
const confirmIn = async (name: RegExp | string) => {
  const buttons = await screen.findAllByRole('button', { name });
  fireEvent.click(buttons.at(-1)!);
};

describe('selection', () => {
  it('ticking a row selects it WITHOUT opening it', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('Invoice ready');

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();
    expect(markMessageAsRead).not.toHaveBeenCalled();
  });

  it('shows no bulk bar until something is ticked', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');
    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument();
  });

  it('shift-click ticks the whole range from the last ticked row', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('Invoice ready');
    tick('My question', { shiftKey: true });

    expect(screen.getByText('3 selected')).toBeInTheDocument();
  });

  it('changing a filter drops the selection', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');
    tick('Invoice ready');

    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: 'high' } });

    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
  });
});

describe('remove from inbox', () => {
  it('removes ONLY the ticked rows, by id, and offers Undo', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('Invoice ready');
    tick('Outage notice');
    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    expect(await screen.findByText(/2 selected messages/)).toBeInTheDocument();
    await confirmIn('Remove');

    await waitFor(() => expect(hideMessages).toHaveBeenCalledWith({ ids: ['m-1', 'm-2'] }));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalled());
    const [, , action] = pageToast.success.mock.calls.at(-1) as [string, unknown, { label: string; onClick: () => void }];
    expect(action.label).toBe('Undo');

    action.onClick();
    await waitFor(() => expect(unhideMessages).toHaveBeenCalledWith(['m-1', 'm-2']));
  });

  it('with nothing ticked, "Remove all N" acts on the active filters', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    fireEvent.change(screen.getByLabelText('Filter by read state'), { target: { value: 'read' } });
    fireEvent.change(screen.getByLabelText('Filter by sender'), { target: { value: 'others' } });
    await waitFor(() => expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({ isRead: true, sentBy: 'others' })));

    fireEvent.click(await screen.findByRole('button', { name: /Remove all 3/ }));
    await confirmIn('Remove');

    await waitFor(() => expect(hideMessages).toHaveBeenCalledWith({ isRead: true, sentBy: 'others' }));
  });

  it('"Select all N" escalates a full page to every match on the server', async () => {
    getMessages.mockResolvedValue(page(rows, 40));
    render(<MessagesPage />);
    await screen.findByText('first body');

    fireEvent.click(screen.getByLabelText('Select all loaded messages'));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 40' }));
    expect(screen.getByText('All 40 selected')).toBeInTheDocument();
    // Per-row actions cannot take a filter scope.
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    await confirmIn('Remove');
    // Filters, not ids — the 37 unloaded rows are included.
    await waitFor(() => expect(hideMessages).toHaveBeenCalledWith({}));
  });
});

describe('removed view', () => {
  it('lists hidden rows and restores the ticked ones', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    fireEvent.change(screen.getByLabelText('Show inbox or removed'), { target: { value: 'removed' } });
    await waitFor(() => expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({ hidden: true })));
    await screen.findByText('first body');

    tick('Invoice ready');
    expect(screen.queryByRole('button', { name: /^Remove$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Restore/ }));

    await waitFor(() => expect(unhideMessages).toHaveBeenCalledWith(['m-1']));
  });
});

describe('read state', () => {
  it('marks the ticked rows read / unread in one call each', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('Invoice ready');
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(setMessagesReadState).toHaveBeenCalledWith(['m-1'], true));

    tick('Outage notice');
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread' }));
    await waitFor(() => expect(setMessagesReadState).toHaveBeenCalledWith(['m-2'], false));
  });
});

describe('delete', () => {
  it('is disabled once the selection includes a message the viewer did not send', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('My question');
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeEnabled();

    tick('Invoice ready');
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeDisabled();
  });

  it('deletes the ticked own messages in ONE bulk call after confirming', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('My question');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(await screen.findByText(/1 selected message and its replies/)).toBeInTheDocument();
    await confirmIn(/^Delete$/);

    await waitFor(() => expect(deleteMessages).toHaveBeenCalledWith(['m-3']));
    expect(deleteMessages).toHaveBeenCalledTimes(1);
  });

  it('reports rows the server refused', async () => {
    deleteMessages.mockResolvedValue({ data: { deleted: [], notFound: [], refused: ['m-3'] } });
    render(<MessagesPage />);
    await screen.findByText('first body');

    tick('My question');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await confirmIn(/^Delete$/);

    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith(expect.stringMatching(/1 message could not be deleted/)));
  });
});

describe('sender + counterparty filters', () => {
  it('offers teammates once the sender select is used, and filters by that author', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    const sender = screen.getByLabelText('Filter by sender');
    fireEvent.focus(sender);
    await screen.findByRole('option', { name: 'dana' });
    fireEvent.change(sender, { target: { value: 'user:u5' } });

    await waitFor(() => expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({ senderUserId: 'u5' })));
  });

  it('filters by a counterparty org seen in the inbox', async () => {
    render(<MessagesPage />);
    await screen.findByText('first body');

    fireEvent.change(screen.getByLabelText('Filter by organization'), { target: { value: 'org-2' } });

    await waitFor(() => expect(getMessages).toHaveBeenLastCalledWith(expect.objectContaining({ counterpartyOrgId: 'org-2' })));
  });
});

describe('URL state', () => {
  it('starts from the filters in the URL', async () => {
    mockRouter.query = { tab: 'all', read: 'unread', from: 'me', removed: '1', q: 'invoice' };
    render(<MessagesPage />);

    await waitFor(() => expect(getMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ isRead: false, sentBy: 'me', hidden: true, search: 'invoice' }),
    ));
  });

  it('writes a changed filter back with a shallow replace, keeping ?message=', async () => {
    mockRouter.query = { message: 'm-1' };
    getMessage.mockResolvedValue({ success: true, data: { message: rows[0] } });
    render(<MessagesPage />);
    await screen.findByText('first body');

    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: 'urgent' } });

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ message: 'm-1', priority: 'urgent' }) }),
      undefined,
      { shallow: true },
    ));
  });

  it('ignores malformed URL values', async () => {
    mockRouter.query = { tab: 'bogus', read: 'maybe', from: 'user:' };
    render(<MessagesPage />);
    await waitFor(() => expect(getMessages).toHaveBeenCalled());
    const params = getMessages.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('isRead');
    expect(params).not.toHaveProperty('senderUserId');
  });
});
