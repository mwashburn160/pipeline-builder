/**
 * SSE-based hook for real-time message notifications.
 * Connects via EventSource to the message service and receives
 * push notifications for new messages, deletions, and unread count updates.
 * Auth is passed via query parameter since EventSource doesn't support custom headers.
 */
import { useState, useRef, useCallback, useMemo } from 'react';
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

  const url = useMemo(() => {
    if (!orgId) return null;
    const token = api.getAccessToken();
    if (!token) return null;
    return `/api/messages/notifications?token=${encodeURIComponent(token)}`;
  }, [orgId]);

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
  });

  return { unreadCount, setUnreadCount, connected, onNotification };
}
