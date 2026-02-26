/**
 * Messaging hook with automatic polling for unread counts.
 * Provides CRUD operations for messages, thread replies, and read-state management.
 * Polls unread count every 30 seconds to keep the sidebar badge current.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/lib/api';
import type { Message, MessageType, MessagePriority } from '@/types';

/** Return type of the {@link useMessages} hook. */
interface UseMessagesReturn {
  messages: Message[];
  loading: boolean;
  error: string | null;
  unreadCount: number;
  fetchMessages: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  sendMessage: (data: { recipientOrgId: string; messageType: MessageType; subject: string; content: string; priority?: MessagePriority }) => Promise<Message | null>;
  replyToMessage: (threadId: string, content: string) => Promise<Message | null>;
  markAsRead: (id: string) => Promise<void>;
  markThreadAsRead: (id: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
}

/** Polling interval for unread message count (30 seconds). */
const POLL_INTERVAL = 30000;

/**
 * Manages message state with automatic polling for unread counts.
 * Fetches messages on mount and polls unread count every 30 seconds.
 *
 * @returns Message state, action callbacks, and unread count
 */
export function useMessages(): UseMessagesReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMessages = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await api.getMessages();
      setMessages(result.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch messages');
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

  const sendMessage = useCallback(async (data: {
    recipientOrgId: string;
    messageType: MessageType;
    subject: string;
    content: string;
    priority?: MessagePriority;
  }): Promise<Message | null> => {
    try {
      const result = await api.sendMessage(data);
      await fetchMessages();
      await fetchUnreadCount();
      return result.data || null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
      return null;
    }
  }, [fetchMessages, fetchUnreadCount]);

  const replyToMessage = useCallback(async (threadId: string, content: string): Promise<Message | null> => {
    try {
      const result = await api.replyToMessage(threadId, content);
      return result.data || null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reply');
      return null;
    }
  }, []);

  const markAsRead = useCallback(async (id: string) => {
    try {
      await api.markMessageAsRead(id);
      setMessages(prev => prev.map(m => m.id === id ? { ...m, isRead: true } : m));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch {
      // Silently fail
    }
  }, []);

  const markThreadAsRead = useCallback(async (id: string) => {
    try {
      await api.markThreadAsRead(id);
      await fetchUnreadCount();
    } catch {
      // Silently fail
    }
  }, [fetchUnreadCount]);

  const deleteMessage = useCallback(async (id: string) => {
    try {
      await api.deleteMessage(id);
      setMessages(prev => prev.filter(m => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete message');
    }
  }, []);

  // Fetch messages on mount
  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Poll unread count
  useEffect(() => {
    fetchUnreadCount();
    pollRef.current = setInterval(fetchUnreadCount, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchUnreadCount]);

  return {
    messages,
    loading,
    error,
    unreadCount,
    fetchMessages,
    fetchUnreadCount,
    sendMessage,
    replyToMessage,
    markAsRead,
    markThreadAsRead,
    deleteMessage,
  };
}
