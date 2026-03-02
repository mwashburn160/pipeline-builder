/**
 * SSE-based hook for real-time message notifications.
 * Connects via EventSource to the message service and receives
 * push notifications for new messages, deletions, and unread count updates.
 * Auth is passed via query parameter since EventSource doesn't support custom headers.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
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
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Set<NotificationListener>>(new Set());
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [reconnectKey, setReconnectKey] = useState(0);

  // Subscribe to notifications
  const onNotification = useCallback((listener: NotificationListener) => {
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  // Reset retry state when orgId changes
  useEffect(() => {
    retryCountRef.current = 0;
    setReconnectKey(0);
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;

    const token = api.getRawAccessToken();
    if (!token) return;

    const url = `/api/messages/notifications?token=${encodeURIComponent(token)}`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setConnected(true);
      retryCountRef.current = 0;
    };

    eventSource.onmessage = (event) => {
      try {
        const parsed: MessageNotification = JSON.parse(event.data);
        retryCountRef.current = 0;

        // Update unread count if provided
        if (parsed.data?.action === 'UNREAD_COUNT' && parsed.data.unreadCount !== undefined) {
          setUnreadCount(parsed.data.unreadCount);
        }

        // Notify all listeners
        listenersRef.current.forEach((listener) => {
          try { listener(parsed); } catch { /* ignore listener errors */ }
        });
      } catch {
        // Ignore malformed SSE data
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setConnected(false);

      if (retryCountRef.current < MESSAGE_SSE_MAX_RETRIES) {
        retryCountRef.current++;
        const delay = MESSAGE_SSE_BASE_RETRY_DELAY_MS * Math.pow(2, retryCountRef.current - 1);
        retryTimerRef.current = setTimeout(() => {
          setReconnectKey(k => k + 1);
        }, delay);
      }
    };

    return () => {
      eventSource.close();
      clearTimeout(retryTimerRef.current);
      setConnected(false);
    };
  }, [orgId, reconnectKey]);

  return { unreadCount, setUnreadCount, connected, onNotification };
}
