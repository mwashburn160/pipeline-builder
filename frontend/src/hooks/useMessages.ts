// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Messaging hook with SSE-driven real-time updates and polling fallback.
 * Provides CRUD operations for messages, thread replies, and read-state management.
 * Uses SSE push notifications when connected; falls back to 30-second polling when not.
 */
import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { MessageListFilters } from '@/lib/api/domains/messages';
import type { Message, MessageType, MessagePriority } from '@/types';
import { acquireLiveUnreadSource, setUnreadCount, useUnreadCount } from '@/lib/unread-count-store';
import { useAsyncCallback } from './useAsync';
import { useMessageNotifications } from './useMessageNotifications';
import { usePolling } from './usePolling';

/**
 * Which slice of the inbox to load. Each value maps to its OWN backend
 * endpoint, so the list is filtered server-side with its own pagination —
 * `'announcements'` / `'conversations'` are not a client-side filter over the
 * mixed `'all'` inbox (that filtered whatever pages happened to be loaded, so
 * a tab could look empty while the server held matching messages).
 */
export type MessageView = 'all' | 'announcements' | 'conversations';

/** Server-side narrowing applied to whichever view is active (search is its
 *  own argument because the page debounces it separately). */
export type MessageFilters = Omit<MessageListFilters, 'search'>;

/** Return type of the {@link useMessages} hook. */
interface UseMessagesReturn {
  messages: Message[];
  loading: boolean;
  error: string | null;
  unreadCount: number;
  /**
   * Server-reported TOTAL for the active view + search (not `messages.length`,
   * which is only the pages loaded so far). Null until the first page lands or
   * when the backend omits pagination.
   */
  total: number | null;
  /**
   * True when real-time SSE updates have dropped after a healthy connection
   * (so the inbox is being kept current by polling, not live push). False
   * during the normal initial connect. Surface a subtle "reconnecting"
   * indicator on this.
   */
  livePaused: boolean;
  /** True when the server reports more inbox pages beyond what's loaded. */
  hasMore: boolean;
  /** True while a `loadMore()` page fetch is in flight. */
  loadingMore: boolean;
  /** Append the next inbox page (server-side pagination) to `messages`. */
  loadMore: () => Promise<void>;
  fetchMessages: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  sendMessage: (data: { recipientOrgId: string; recipientUserId?: string; messageType: MessageType; subject: string; content: string; priority?: MessagePriority; channel?: string }) => Promise<Message | null>;
  replyToMessage: (threadId: string, content: string, attachmentIds?: string[]) => Promise<Message | null>;
  markAsRead: (id: string) => Promise<void>;
  markThreadAsRead: (id: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
}

/** Polling interval for unread message count fallback (30 seconds). */
export const POLL_INTERVAL = 30000;

/** Inbox page size for the initial fetch + each `loadMore`. */
export const MESSAGE_PAGE_SIZE = 25;

/**
 * Manages message state with SSE-driven real-time updates.
 * Falls back to polling when SSE is disconnected.
 *
 * @param orgId - Organization ID for SSE subscription (optional, disables SSE if not provided)
 * @param search - Free-text inbox search (subject/content); pass the DEBOUNCED
 *   value. Changing it refetches page 0 server-side.
 * @param view - Which slice to load. Each maps to its own endpoint; changing it
 *   refetches page 0 against that endpoint.
 * @param filters - Read-state / priority / channel narrowing, applied server-side
 *   to the active view; changing it refetches page 0.
 * @returns Message state, action callbacks, and unread count
 */
export function useMessages(orgId?: string | null, search = '', view: MessageView = 'all', filters: MessageFilters = {}): UseMessagesReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Shared with the sidebar badge (see unread-count-store), so both update together.
  const { unreadCount } = useUnreadCount();
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Kept in a ref so fetchMessages/loadMore stay stable (no SSE/poll effect
  // churn) while still reading the CURRENT search term.
  const searchRef = useRef(search);
  searchRef.current = search;
  // Same treatment for the active view — the SSE/poll effects hold a stable
  // fetchMessages and must always hit the CURRENTLY selected endpoint.
  const viewRef = useRef(view);
  viewRef.current = view;
  // …and for the filters. `filterKey` is the effect dependency, so an inline
  // `{}` literal from the caller doesn't refetch on every render.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const filterKey = JSON.stringify([filters.isRead, filters.priority, filters.channel]);
  // Current page contents, readable from the (stable) SSE handler.
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  /** Fetch one page of the ACTIVE view from its own endpoint. */
  const fetchPage = useCallback((offset: number) => {
    const { isRead, priority, channel } = filtersRef.current;
    const params = {
      limit: MESSAGE_PAGE_SIZE,
      offset,
      ...(searchRef.current ? { search: searchRef.current } : {}),
      ...(isRead !== undefined ? { isRead } : {}),
      ...(priority ? { priority } : {}),
      ...(channel ? { channel } : {}),
    };
    if (viewRef.current === 'announcements') return api.getAnnouncements(params);
    if (viewRef.current === 'conversations') return api.getConversations(params);
    return api.getMessages(params);
  }, []);

  // SSE notifications
  const {
    unreadCount: sseUnreadCount,
    connected,
    everConnected,
    onNotification,
  } = useMessageNotifications(orgId ?? null);

  // Only "paused" once we've been live and then lost it — never during the
  // benign initial handshake (avoids flashing the indicator on first load).
  const livePaused = everConnected && !connected;

  const fetchMessages = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await fetchPage(0);
      setMessages(result.data?.messages || []);
      setHasMore(result.data?.pagination?.hasMore ?? false);
      setTotal(result.data?.pagination?.total ?? null);
    } catch (err) {
      setError(formatError(err, 'Failed to fetch messages'));
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    // Guard re-entrancy: a second click while a page is in flight is a no-op.
    if (loadingMore) return;
    try {
      setLoadingMore(true);
      setError(null);
      const result = await fetchPage(messages.length);
      const next = result.data?.messages ?? [];
      // Dedupe on append: SSE/poll may have shifted the head of the list between
      // pages, so drop any id we already hold rather than rendering a duplicate.
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...next.filter((m) => !seen.has(m.id))];
      });
      setHasMore(result.data?.pagination?.hasMore ?? false);
      setTotal(result.data?.pagination?.total ?? null);
    } catch (err) {
      setError(formatError(err, 'Failed to load more messages'));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, messages.length, fetchPage]);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const result = await api.getUnreadCount();
      setUnreadCount(result.data?.count || 0);
    } catch {
      // Silently fail — unread count is non-critical
    }
  }, []);

  const { execute: sendMessageRaw, error: sendError } = useAsyncCallback(async (data: {
    recipientOrgId: string;
    recipientUserId?: string;
    messageType: MessageType;
    subject: string;
    content: string;
    priority?: MessagePriority;
    channel?: string;
  }): Promise<Message | null> => {
    const result = await api.sendMessage(data);
    await fetchMessages();
    await fetchUnreadCount();
    return result.data || null;
  });

  const sendMessage = useCallback(async (data: {
    recipientOrgId: string;
    recipientUserId?: string;
    messageType: MessageType;
    subject: string;
    content: string;
    priority?: MessagePriority;
    channel?: string;
  }): Promise<Message | null> => {
    const result = await sendMessageRaw(data);
    if (!result && !sendError) setError('Failed to send message');
    return result;
  }, [sendMessageRaw, sendError]);

  const { execute: replyRaw } = useAsyncCallback(async (threadId: string, content: string, attachmentIds?: string[]): Promise<Message | null> => {
    const result = await api.replyToMessage(threadId, content, attachmentIds);
    return result.data || null;
  });

  const replyToMessage = useCallback(async (threadId: string, content: string, attachmentIds?: string[]): Promise<Message | null> => {
    const result = await replyRaw(threadId, content, attachmentIds);
    if (!result) setError('Failed to send reply');
    return result;
  }, [replyRaw]);

  const markAsRead = useCallback(async (id: string) => {
    try {
      await api.markMessageAsRead(id);
      // Optimistic per-participant update: stamp our org's readBy entry so
      // the row immediately stops looking unread for this viewer. Server's
      // returned `readBy` will overwrite on the next list refetch.
      const stamp = new Date().toISOString();
      const orgKey = orgId?.toLowerCase();
      if (orgKey) {
        let wasUnread = false;
        setMessages(prev => prev.map(m => {
          if (m.id !== id) return m;
          if (!m.readBy?.[orgKey]) wasUnread = true;
          return { ...m, readBy: { ...m.readBy, [orgKey]: stamp } };
        }));
        // Only decrement when this viewer hadn't already read it — decrementing
        // on an already-read message drifts the badge below the true count.
        if (wasUnread) setUnreadCount(prev => Math.max(0, prev - 1));
      }
    } catch {
      // Silently fail
    }
  }, [orgId]);

  const markThreadAsRead = useCallback(async (id: string) => {
    try {
      await api.markThreadAsRead(id);
      await fetchUnreadCount();
    } catch {
      // Silently fail
    }
  }, [fetchUnreadCount]);

  const { execute: deleteRaw } = useAsyncCallback(async (id: string) => {
    await api.deleteMessage(id);
    return id;
  });

  const deleteMessage = useCallback(async (id: string) => {
    const deletedId = await deleteRaw(id);
    if (deletedId) {
      setMessages(prev => prev.filter(m => m.id !== deletedId));
      // Keep the view's count honest without a refetch — the row is gone from
      // the server's total too.
      setTotal(prev => (prev == null ? prev : Math.max(0, prev - 1)));
    } else {
      setError('Failed to delete message');
    }
  }, [deleteRaw]);

  // Fetch messages on mount AND whenever the (debounced) search term, the
  // active view or the filters change — fetchMessages is stable and reads all
  // three from refs, so this resets to page 0 for the new query/endpoint without
  // churning the SSE/poll effects.
  useEffect(() => {
    fetchMessages();
  }, [fetchMessages, search, view, filterKey]);

  // Sync SSE-provided unread count into local state
  useEffect(() => {
    if (connected) {
      setUnreadCount(sseUnreadCount);
    }
  }, [sseUnreadCount, connected]);

  // Handle SSE notifications for real-time updates
  useEffect(() => {
    if (!connected) return;

    const unsub = onNotification((notification) => {
      switch (notification.data?.action) {
        case 'NEW_MESSAGE':
          fetchMessages();
          fetchUnreadCount();
          break;
        case 'MESSAGE_DELETED':
          if (notification.data.messageId) {
            const goneId = notification.data.messageId;
            // Decrement the view's total only when the row was actually part of
            // it (the notification is org-wide, so it may name a message from a
            // different tab). A miss self-corrects on the next page fetch.
            if (messagesRef.current.some(m => m.id === goneId)) {
              setTotal(prev => (prev == null ? prev : Math.max(0, prev - 1)));
            }
            setMessages(prev => prev.filter(m => m.id !== goneId));
          }
          fetchUnreadCount();
          break;
      }
    });

    return unsub;
  }, [connected, onNotification, fetchMessages, fetchUnreadCount]);

  // This hook keeps the shared unread count current (SSE, or the fallback poll
  // below), so the sidebar badge doesn't poll it separately while we're mounted.
  // A layout effect, so it's in place before the layout's (child) polling effect
  // runs its first tick in the same commit.
  useLayoutEffect(() => acquireLiveUnreadSource(), []);

  // Polling fallback: only poll when SSE is disconnected. Refresh BOTH the
  // unread count and the message LIST so the inbox stays current during an
  // outage — not just the badge. Stops as soon as SSE reconnects, so live push
  // never runs alongside polling.
  useEffect(() => {
    if (!connected) void fetchUnreadCount();
  }, [connected, fetchUnreadCount]);
  usePolling(() => {
    void fetchUnreadCount();
    void fetchMessages();
  }, POLL_INTERVAL, { enabled: !connected, immediate: false });

  return {
    messages,
    loading,
    error,
    unreadCount,
    total,
    livePaused,
    hasMore,
    loadingMore,
    loadMore,
    fetchMessages,
    fetchUnreadCount,
    sendMessage,
    replyToMessage,
    markAsRead,
    markThreadAsRead,
    deleteMessage,
  };
}
