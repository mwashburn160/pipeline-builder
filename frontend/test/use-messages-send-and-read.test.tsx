// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useMessages: a failed send surfaces the SERVER's reason on every failure
 * (it used to read a render-time error that was still null, and only said
 * "Failed to send message"), and markAsRead decides whether to decrement the
 * unread badge from the current list rather than a flag set inside a
 * `setMessages` updater that may not have run yet.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMessages } from '../src/hooks/useMessages';
import { __resetUnreadCountStoreForTests } from '../src/lib/unread-count-store';

const sendMessage = jest.fn<AnyFn>();
const markMessageAsRead = jest.fn<AnyFn>();
const getMessages = jest.fn<AnyFn>();
const getUnreadCount = jest.fn<AnyFn>();
const deleteMessage = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    markMessageAsRead: (...a: unknown[]) => markMessageAsRead(...a),
    getMessages: (...a: unknown[]) => getMessages(...a),
    getUnreadCount: (...a: unknown[]) => getUnreadCount(...a),
    deleteMessage: (...a: unknown[]) => deleteMessage(...a),
  },
}));
jest.mock('@/hooks/useMessageNotifications', () => ({
  __esModule: true,
  useMessageNotifications: () => ({ unreadCount: 0, connected: false, everConnected: false, onNotification: () => () => {} }),
}));
jest.mock('@/hooks/usePolling', () => ({ __esModule: true, usePolling: () => {} }));

const row = (id: string, readBy: Record<string, string> = {}) => ({ id, subject: id, content: '', readBy });
const SEND = { recipientOrgId: 'org-2', messageType: 'conversation' as const, subject: 's', content: 'c' };

beforeEach(() => {
  jest.clearAllMocks();
  __resetUnreadCountStoreForTests();
  getMessages.mockResolvedValue({
    data: { messages: [row('m-unread'), row('m-read', { 'org-1': '2026-01-01T00:00:00Z' })], pagination: { total: 2, hasMore: false } },
  });
  getUnreadCount.mockResolvedValue({ data: { count: 3 } });
  markMessageAsRead.mockResolvedValue({ success: true });
});

async function mounted() {
  const hook = renderHook(() => useMessages('org-1'));
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(2));
  await waitFor(() => expect(hook.result.current.unreadCount).toBe(3));
  return hook;
}

describe('useMessages().sendMessage failures', () => {
  it('surfaces the server reason on the first failure and on every retry, and rejects with it', async () => {
    const { result } = await mounted();
    sendMessage.mockRejectedValueOnce(new Error('Recipient organization does not accept messages'));

    await act(async () => {
      await expect(result.current.sendMessage(SEND)).rejects.toThrow('Recipient organization does not accept messages');
    });
    expect(result.current.error).toBe('Recipient organization does not accept messages');

    sendMessage.mockRejectedValueOnce(new Error('Message quota exceeded'));
    await act(async () => {
      await expect(result.current.sendMessage(SEND)).rejects.toThrow('Message quota exceeded');
    });
    expect(result.current.error).toBe('Message quota exceeded');
  });

  it('resolves with the sent message on success', async () => {
    const { result } = await mounted();
    sendMessage.mockResolvedValue({ data: { id: 'm-new' } });
    let sent: unknown;
    await act(async () => { sent = await result.current.sendMessage(SEND); });
    expect(sent).toEqual({ id: 'm-new' });
    expect(result.current.error).toBeNull();
  });
});

describe('useMessages().markAsRead', () => {
  it('decrements the badge for an unread message and stamps it read', async () => {
    const { result } = await mounted();
    await act(async () => { await result.current.markAsRead('m-unread'); });
    expect(result.current.unreadCount).toBe(2);
    expect(result.current.messages.find((m) => m.id === 'm-unread')?.readBy['org-1']).toBeTruthy();
  });

  it('does not decrement for a message already read', async () => {
    const { result } = await mounted();
    await act(async () => { await result.current.markAsRead('m-read'); });
    expect(result.current.unreadCount).toBe(3);
  });

  it('two marks of the same message before a re-render decrement once', async () => {
    const { result } = await mounted();
    await act(async () => {
      await Promise.all([result.current.markAsRead('m-unread'), result.current.markAsRead('m-unread')]);
    });
    expect(result.current.unreadCount).toBe(2);
  });
});

describe('useMessages().deleteMessage', () => {
  it('resolves true and drops the row on success', async () => {
    const { result } = await mounted();
    deleteMessage.mockResolvedValue({ success: true });
    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.deleteMessage('m-read'); });
    expect(ok).toBe(true);
    expect(result.current.messages.map((m) => m.id)).toEqual(['m-unread']);
  });

  it('resolves false, keeps the row and reports the error on failure', async () => {
    const { result } = await mounted();
    deleteMessage.mockRejectedValue(new Error('Delete refused'));
    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.deleteMessage('m-read'); });
    expect(ok).toBe(false);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.error).toBe('Delete refused');
  });
});
