// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * MESSAGE_EDITED on the live stream: an edit of a message (or an announcement,
 * broadcast to every org) refreshes the inbox row and tells the open thread to
 * re-read, instead of showing the old text until the next manual reload.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act } from '@testing-library/react';
import type { MessageNotification, NotificationListener } from '../src/hooks/useMessageNotifications';

const getUnreadCount = jest.fn<AnyFn>();
const getMessages = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getUnreadCount: (...a: unknown[]) => getUnreadCount(...a),
    getMessages: (...a: unknown[]) => getMessages(...a),
  },
}));
let listener: NotificationListener | null = null;
jest.mock('../src/hooks/useMessageNotifications', () => ({
  useMessageNotifications: () => ({
    connected: true,
    everConnected: true,
    onNotification: (l: NotificationListener) => { listener = l; return () => { listener = null; }; },
  }),
}));

import { __resetUnreadCountStoreForTests } from '../src/lib/unread-count-store';
import { useMessages } from '../src/hooks/useMessages';

const flush = async () => { await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); }); };
const edited = (messageId: string, threadId: string): MessageNotification => ({
  ts: '2026-11-19T00:00:00Z', type: 'MESSAGE', message: 'Message edited', data: { action: 'MESSAGE_EDITED', messageId, threadId },
});
const row = (id: string) => ({ id, threadId: id, subject: 's', content: 'old', messageType: 'conversation' });

beforeEach(() => {
  __resetUnreadCountStoreForTests();
  listener = null;
  getUnreadCount.mockReset().mockResolvedValue({ data: { count: 0 } });
  getMessages.mockReset().mockResolvedValue({ data: { messages: [row('m1'), row('a1')], pagination: { hasMore: false, total: 2 } } });
});

describe('useMessages — MESSAGE_EDITED', () => {
  it('re-reads the list when an edited message (or a reply in its thread) is loaded, and signals the thread', async () => {
    const { result } = renderHook(() => useMessages('org-1'));
    await flush();
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(result.current.lastEdit).toBeNull();

    await act(async () => { listener?.(edited('a1', 'a1')); });
    await flush();
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(result.current.lastEdit).toMatchObject({ messageId: 'a1', threadId: 'a1' });

    // A reply inside m1's thread: the row is the thread root.
    const before = result.current.lastEdit!.seq;
    await act(async () => { listener?.(edited('r9', 'm1')); });
    await flush();
    expect(getMessages).toHaveBeenCalledTimes(3);
    expect(result.current.lastEdit).toMatchObject({ messageId: 'r9', threadId: 'm1' });
    expect(result.current.lastEdit!.seq).toBeGreaterThan(before);
  });

  it('an edit of a message this view has not loaded spends no list read', async () => {
    const { result } = renderHook(() => useMessages('org-1'));
    await flush();
    await act(async () => { listener?.(edited('zz', 'zz')); });
    await flush();
    expect(getMessages).toHaveBeenCalledTimes(1);
    // An open deep-linked thread still hears about it.
    expect(result.current.lastEdit).toMatchObject({ threadId: 'zz' });
  });
});
