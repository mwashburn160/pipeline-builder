// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The messages hook's polling fallback (live stream down) reads the unread
 * COUNT — a quota-exempt route — every tick, and re-fetches the metered message
 * LIST only when that count moves. It used to fetch the list every 30s for as
 * long as the stream was down.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act } from '@testing-library/react';

const getUnreadCount = jest.fn<AnyFn>();
const getMessages = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getUnreadCount: (...a: unknown[]) => getUnreadCount(...a),
    getMessages: (...a: unknown[]) => getMessages(...a),
  },
}));
// The live stream is DOWN for this whole file — the fallback is what's under test.
jest.mock('../src/hooks/useMessageNotifications', () => ({
  useMessageNotifications: () => ({ connected: false, everConnected: true, onNotification: () => () => {} }),
}));

import { __resetUnreadCountStoreForTests } from '../src/lib/unread-count-store';
import { POLL_INTERVAL, useMessages } from '../src/hooks/useMessages';

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const tick = async () => { await act(async () => { jest.advanceTimersByTime(POLL_INTERVAL); }); await flush(); };

beforeEach(() => {
  jest.useFakeTimers();
  __resetUnreadCountStoreForTests();
  getUnreadCount.mockReset().mockResolvedValue({ data: { count: 2 } });
  getMessages.mockReset().mockResolvedValue({ data: { messages: [], pagination: { hasMore: false, total: 0 } } });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useMessages polling fallback', () => {
  it('polls the free unread count, and fetches the list only when the count changes', async () => {
    renderHook(() => useMessages('org-1'));
    await flush();
    // Mount: one list read + the seeding count read.
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getUnreadCount).toHaveBeenCalledTimes(1);

    // Quiet inbox: every tick reads the count, none re-reads the list.
    await tick();
    await tick();
    await tick();
    expect(getUnreadCount).toHaveBeenCalledTimes(4);
    expect(getMessages).toHaveBeenCalledTimes(1);

    // Something arrived: the count moves, so the list is fetched — once.
    getUnreadCount.mockResolvedValue({ data: { count: 3 } });
    await tick();
    expect(getMessages).toHaveBeenCalledTimes(2);
    await tick();
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it('does not fetch the list when the count read fails', async () => {
    renderHook(() => useMessages('org-1'));
    await flush();
    getUnreadCount.mockRejectedValue(new Error('message service down'));
    await tick();
    expect(getMessages).toHaveBeenCalledTimes(1);
  });
});
