/**
 * SSE-based hook for real-time message notifications.
 * Connects via EventSource to the message service and receives
 * push notifications for new messages, deletions, and unread count updates.
 * Uses a short-lived ticket exchange so JWTs never appear in query strings.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useSSE } from './useSSE';
import api from '@/lib/api';
import { MESSAGE_SSE_MAX_RETRIES, MESSAGE_SSE_BASE_RETRY_DELAY_MS } from '@/lib/constants';

/** Discriminator for message notification actions. */
export type MessageNotificationAction = 'NEW_MESSAGE' | 'MESSAGE_DELETED' | 'UNREAD_COUNT';

/** A message notification event received via SSE. */
export interface MessageNotification {
  ts: string;
  type: string;
  message: string;
  data?: {
    action: MessageNotificationAction;
    messageId?: string;
    threadId?: string;
    subject?: string;
    senderOrgId?: string;
    messageType?: string;
    unreadCount?: number;
  };
}

/** Callback signature for notification listeners. */
export type NotificationListener = (notification: MessageNotification) => void;

/**
 * Connects to the message service SSE endpoint and provides real-time notifications.
 *
 * @param orgId - The org to subscribe to, or null to stay disconnected
 * @returns Object with unreadCount state, connection status, and notification subscription
 */
export function useMessageNotifications(orgId: string | null) {
  const [unreadCount, setUnreadCount] = useState(0);
  const listenersRef = useRef<Set<NotificationListener>>(new Set());

  const onNotification = useCallback((listener: NotificationListener) => {
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  // Exchange JWT for a single-use SSE ticket so the JWT never appears in URLs.
  // A fresh ticket is fetched for each connection attempt (tickets are single-use).
  const [url, setUrl] = useState<string | null>(null);
  const [ticketKey, setTicketKey] = useState(0);

  useEffect(() => {
    if (!orgId || !api.isAuthenticated()) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    api.getNotificationTicket()
      .then((ticket) => {
        if (!cancelled) setUrl(`/api/messages/notifications?ticket=${encodeURIComponent(ticket)}`);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => { cancelled = true; };
  }, [orgId, ticketKey]);

  // When the SSE connection drops, fetch a fresh ticket for the next attempt
  const onRetriesExhausted = useCallback(() => {
    setTicketKey((k) => k + 1);
  }, []);

  const onMessage = useCallback((data: unknown) => {
    const parsed = data as MessageNotification;

    if (parsed.data?.action === 'UNREAD_COUNT' && parsed.data.unreadCount !== undefined) {
      setUnreadCount(parsed.data.unreadCount);
    }

    listenersRef.current.forEach((listener) => {
      try { listener(parsed); } catch { /* ignore listener errors */ }
    });
  }, []);

  const { connected } = useSSE({
    url,
    maxRetries: MESSAGE_SSE_MAX_RETRIES,
    baseRetryDelayMs: MESSAGE_SSE_BASE_RETRY_DELAY_MS,
    onMessage,
    onRetriesExhausted,
  });

  return { unreadCount, setUnreadCount, connected, onNotification };
}
