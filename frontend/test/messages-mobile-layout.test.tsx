// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox on a phone: the conversation list and the open thread are ONE
 * column at a time, with a Back control between them.
 *
 * Below `lg` only the pane in use is rendered — the list until a conversation
 * is opened, then the thread — and focus follows the swap: it lands on the
 * thread's Back button when a row is opened (the row just left the screen),
 * and returns to that row on Back. On a desktop both panes stay side by side.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { mockViewport, resetViewport } from './helpers/viewport';
import MessagesPage from '../src/components/message/MessagesTab';
import type { ThreadView as RealThreadView } from '../src/components/message/ThreadView';
import type { Message } from '../src/types';

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

// The page tests swap in a stand-in thread (its own fetches are out of scope)
// that records whether the page asked it to take focus; the ThreadView suite
// at the bottom renders the real one.
const threadProps: Array<{ autoFocusBack?: boolean }> = [];
jest.mock('@/components/message/ThreadView', () => {
  const actual = jest.requireActual('@/components/message/ThreadView') as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    ThreadView: (props: { rootMessage: { subject: string }; onBack: () => void; autoFocusBack?: boolean }) => {
      threadProps.push({ autoFocusBack: props.autoFocusBack });
      return (
        <div data-testid="thread">
          <button type="button" onClick={props.onBack}>Back</button>
          {props.rootMessage.subject}
        </div>
      );
    },
    RealThreadView: actual.ThreadView,
  };
});

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/inbox', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const getMessages = jest.fn<AnyFn>();
const getThread = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getMessages: (...a: unknown[]) => getMessages(...a),
    getMessage: () => Promise.resolve({ success: false }),
    markMessageAsRead: () => Promise.resolve({ success: true }),
    getUnreadCount: () => Promise.resolve({ data: { count: 0 } }),
    getThread: (...a: unknown[]) => getThread(...a),
  },
}));

const MSG = {
  id: 'm-1', subject: 'Deploy failed', content: 'prod deploy is red', orgId: 'org-2', recipientOrgId: 'org-1',
  messageType: 'conversation', createdAt: '2026-01-01T00:00:00Z', readBy: { 'org-1': '2026-01-01T00:00:00Z' },
};

const row = () => (screen.queryByText('prod deploy is red')?.closest<HTMLElement>('[role="button"]') ?? null);

beforeEach(() => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  mockRouter.query = {};
  mockRouter.replace.mockClear();
  threadProps.length = 0;
  getMessages.mockReset().mockResolvedValue({ data: { messages: [MSG], pagination: { total: 1, limit: 25, offset: 0, hasMore: false } } });
});
afterEach(() => resetViewport());

describe('inbox on a phone (390px)', () => {
  beforeEach(() => mockViewport(390));

  it('shows only the list until a conversation is opened — no empty thread pane beside it', async () => {
    render(<MessagesPage />);
    expect(await screen.findByText('prod deploy is red')).toBeInTheDocument();
    expect(screen.queryByText('Select a conversation')).not.toBeInTheDocument();
  });

  it('swaps the list for the thread, focuses Back, and returns focus to the row on Back', async () => {
    render(<MessagesPage />);
    await screen.findByText('prod deploy is red');

    fireEvent.click(row()!);
    expect(await screen.findByTestId('thread')).toHaveTextContent('Deploy failed');
    // The list is gone, not merely hidden behind the thread.
    expect(row()).toBeNull();
    expect(screen.queryByLabelText('Search messages')).not.toBeInTheDocument();
    expect(threadProps.at(-1)?.autoFocusBack).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(row()).not.toBeNull());
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();
    await waitFor(() => expect(row()).toHaveFocus());
  });
});

describe('inbox on a desktop', () => {
  it('keeps the list and the thread side by side, and leaves focus where it was', async () => {
    render(<MessagesPage />);
    await screen.findByText('prod deploy is red');
    expect(screen.getByText('Select a conversation')).toBeInTheDocument();

    fireEvent.click(row()!);
    expect(await screen.findByTestId('thread')).toBeInTheDocument();
    expect(row()).not.toBeNull();
    expect(threadProps.at(-1)?.autoFocusBack).toBe(false);
  });
});

describe('ThreadView autoFocusBack', () => {
  const ThreadView = (jest.requireMock('@/components/message/ThreadView') as { RealThreadView: typeof RealThreadView }).RealThreadView;
  const ROOT = { ...MSG, createdBy: 'u2', priority: 'normal', attachments: [] } as unknown as Message;

  beforeEach(() => { getThread.mockReset().mockResolvedValue({ data: { messages: [ROOT] } }); });

  it('moves focus to Back when asked, so a phone user is not left focused on a row that is gone', async () => {
    render(<ThreadView rootMessage={ROOT} currentOrgId="org-1" currentUserId="u1" onBack={() => {}} onThreadRead={() => {}} autoFocusBack />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus());
  });

  it('leaves focus alone otherwise', async () => {
    render(<ThreadView rootMessage={ROOT} currentOrgId="org-1" currentUserId="u1" onBack={() => {}} onThreadRead={() => {}} />);
    await waitFor(() => expect(getThread).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Back' })).not.toHaveFocus();
  });
});
