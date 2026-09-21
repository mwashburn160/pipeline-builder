// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox tabs must be SERVER-filtered.
 *
 * Regression for: `messages.tsx` filtered `messageType` client-side over the
 * already-paginated mixed inbox, so "Announcements" / "Conversations" showed
 * only whatever happened to be in the pages fetched so far — the list, its
 * count and its empty state were all wrong whenever the matching rows sat
 * beyond the loaded pages. Each tab now drives its own endpoint with its own
 * pagination.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useMessages, MESSAGE_PAGE_SIZE } from '../src/hooks/useMessages';

const getMessages = jest.fn<AnyFn>();
const getAnnouncements = jest.fn<AnyFn>();
const getConversations = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getMessages: (...a: unknown[]) => getMessages(...a),
    getAnnouncements: (...a: unknown[]) => getAnnouncements(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    getUnreadCount: jest.fn<AnyFn>().mockResolvedValue({ data: { count: 0 } }),
  },
}));

// SSE is irrelevant here (and would open an EventSource): pin it disconnected so
// the hook's fetch path is the only thing under test.
jest.mock('@/hooks/useMessageNotifications', () => ({
  __esModule: true,
  useMessageNotifications: () => ({
    unreadCount: 0,
    connected: false,
    everConnected: false,
    onNotification: () => () => {},
  }),
}));

// The polling fallback would fire extra fetches on a timer; the hook's own
// mount fetch is what these assertions are about.
jest.mock('@/hooks/usePolling', () => ({
  __esModule: true,
  usePolling: () => {},
}));

/** One page envelope in the shape the message service returns. */
function page(messages: unknown[], total: number, hasMore = false, offset = 0) {
  return { data: { messages, pagination: { total, limit: MESSAGE_PAGE_SIZE, offset, hasMore } } };
}

beforeEach(() => {
  getMessages.mockReset();
  getAnnouncements.mockReset();
  getConversations.mockReset();
});

describe('useMessages view routing', () => {
  it('drives each tab from its own endpoint', async () => {
    getMessages.mockResolvedValue(page([], 0));
    getAnnouncements.mockResolvedValue(page([], 0));
    getConversations.mockResolvedValue(page([], 0));

    const { result, rerender } = renderHook(
      ({ view }: { view: 'all' | 'announcements' | 'conversations' }) => useMessages('org-1', '', view),
      { initialProps: { view: 'all' as 'all' | 'announcements' | 'conversations' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getMessages).toHaveBeenCalledTimes(1);

    rerender({ view: 'announcements' });
    await waitFor(() => expect(getAnnouncements).toHaveBeenCalledTimes(1));

    rerender({ view: 'conversations' });
    await waitFor(() => expect(getConversations).toHaveBeenCalledTimes(1));

    // The mixed inbox was never re-queried to build a tab — that query is what
    // used to bound a tab to the pages it had loaded.
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  /**
   * THE regression test: the announcement the user is looking for is NOT in the
   * inbox page. Under the old client-side filter the Announcements tab would
   * have rendered nothing at all; now it renders what the server holds.
   */
  it('shows a tab row the loaded inbox page does not contain', async () => {
    // A full first inbox page of conversations only — no announcement in sight.
    const inboxPage = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) => ({ id: `c${i}`, messageType: 'conversation' }));
    getMessages.mockResolvedValue(page(inboxPage, 500, true));
    getAnnouncements.mockResolvedValue(page([{ id: 'a-late', messageType: 'announcement' }], 1));

    const { result, rerender } = renderHook(
      ({ view }: { view: 'all' | 'announcements' | 'conversations' }) => useMessages('org-1', '', view),
      { initialProps: { view: 'all' as 'all' | 'announcements' | 'conversations' } },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(MESSAGE_PAGE_SIZE));
    expect(result.current.messages.some((m) => m.id === 'a-late')).toBe(false);

    rerender({ view: 'announcements' });

    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['a-late']));
    // …and the count is the SERVER's for that tab, not a slice of the inbox.
    expect(result.current.total).toBe(1);
  });

  it('reports the tab\'s own server total, not the number of loaded rows', async () => {
    getAnnouncements.mockResolvedValue(page([{ id: 'a1' }, { id: 'a2' }], 97, true));

    const { result } = renderHook(() => useMessages('org-1', '', 'announcements'));

    await waitFor(() => expect(result.current.total).toBe(97));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.hasMore).toBe(true);
  });

  it('pages a tab against its OWN endpoint and offset', async () => {
    getAnnouncements
      .mockResolvedValueOnce(page([{ id: 'a1' }], 2, true))
      .mockResolvedValueOnce(page([{ id: 'a2' }], 2, false, 1));

    const { result } = renderHook(() => useMessages('org-1', '', 'announcements'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await act(async () => { await result.current.loadMore(); });

    expect(getAnnouncements).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }));
    expect(result.current.messages.map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('forwards the search term to the active tab endpoint', async () => {
    getConversations.mockResolvedValue(page([], 0));

    renderHook(() => useMessages('org-1', 'outage', 'conversations'));

    await waitFor(() => expect(getConversations).toHaveBeenCalledWith(expect.objectContaining({ search: 'outage' })));
  });
});
