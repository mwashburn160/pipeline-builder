// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Messaging hook with SSE-driven real-time updates and polling fallback.
 * Provides CRUD operations for messages, thread replies, and read-state management.
 * Uses SSE push notifications when connected; falls back to 30-second polling when not.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { Message, MessageType, MessagePriority } from '@/types';
import { useAsyncCallback } from './useAsync';
import { useMessageNotifications } from './useMessageNotifications';

/** Return type of the {@link useMessages} hook. */
interface UseMessagesReturn {
  messages: Message[];
  loading: boolean;
  error: string | null;
  unreadCount: number;
  /**
   * True when real-time SSE updates have dropped after a healthy connection
   * (so the inbox is being kept current by polling, not live push). False
   * during the normal initial connect. Surface a subtle "reconnecting"
   * indicator on this.
   */
  livePaused: boolean;
  fetchMessages: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  sendMessage: (data: { recipientOrgId: string; messageType: MessageType; subject: string; content: string; priority?: MessagePriority; channel?: string }) => Promise<Message | null>;
  replyToMessage: (threadId: string, content: string) => Promise<Message | null>;
  markAsRead: (id: string) => Promise<void>;
  markThreadAsRead: (id: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
}

/** Polling interval for unread message count fallback (30 seconds). */
export const POLL_INTERVAL = 30000;

/**
 * Manages message state with SSE-driven real-time updates.
 * Falls back to polling when SSE is disconnected.
 *
 * @param orgId - Organization ID for SSE subscription (optional, disables SSE if not provided)
 * @returns Message state, action callbacks, and unread count
 */
export function useMessages(orgId?: string | null): UseMessagesReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      const result = await api.getMessages();
      setMessages(result.data?.messages || []);
    } catch (err) {
      setError(formatError(err, 'Failed to fetch messages'));
    } finally {
      setLoading(false);
    }
  }, []);

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

  const { execute: replyRaw } = useAsyncCallback(async (threadId: string, content: string): Promise<Message | null> => {
    const result = await api.replyToMessage(threadId, content);
    return result.data || null;
  });

  const replyToMessage = useCallback(async (threadId: string, content: string): Promise<Message | null> => {
    const result = await replyRaw(threadId, content);
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
    } else {
      setError('Failed to delete message');
    }
  }, [deleteRaw]);

  // Fetch messages on mount
  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

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
            setMessages(prev => prev.filter(m => m.id !== notification.data?.messageId));
          }
          fetchUnreadCount();
          break;
      }
    });

    return unsub;
  }, [connected, onNotification, fetchMessages, fetchUnreadCount]);

  // Polling fallback: only poll when SSE is disconnected. Refresh BOTH the
  // unread count and the message LIST so the inbox stays current during an
  // outage — not just the badge. The interval is cleared on unmount and as
  // soon as SSE reconnects (connected → true), so live push never runs
  // alongside polling.
  useEffect(() => {
    if (connected) return;

    fetchUnreadCount();
    pollRef.current = setInterval(() => {
      fetchUnreadCount();
      fetchMessages();
    }, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchUnreadCount, fetchMessages, connected]);

  return {
    messages,
    loading,
    error,
    unreadCount,
    livePaused,
    fetchMessages,
    fetchUnreadCount,
    sendMessage,
    replyToMessage,
    markAsRead,
    markThreadAsRead,
    deleteMessage,
  };
}
