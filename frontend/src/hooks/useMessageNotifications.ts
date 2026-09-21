// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSE-based hook for real-time message notifications. Connects to the message
 * service and receives push notifications for new messages, deletions, and
 * unread-count updates. The ticket exchange + reconnect/backoff live in
 * {@link useTicketedSSE}; this hook adds the unread-count state + a listener
 * subscription on top.
 */
import { useRef, useCallback } from 'react';
import { useTicketedSSE } from './useTicketedSSE';
import api from '@/lib/api';

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
  };
}

/** Callback signature for notification listeners. */
export type NotificationListener = (notification: MessageNotification) => void;

/**
 * Connects to the message service SSE endpoint and provides real-time notifications.
 *
 * @param orgId - The org to subscribe to, or null to stay disconnected
 * @returns connection status and a notification subscription. It deliberately
 *   holds no unread COUNT: that lives in the shared store and is only ever set
 *   from the server, never from a frame (see useMessages).
 */
export function useMessageNotifications(orgId: string | null) {
  const listenersRef = useRef<Set<NotificationListener>>(new Set());

  const onNotification = useCallback((listener: NotificationListener) => {
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  const { connected, everConnected } = useTicketedSSE({
    subscriptionKey: orgId && api.isAuthenticated() ? orgId : null,
    getTicket: () => api.getNotificationTicket(),
    buildUrl: (ticket) => `/api/messages/notifications?ticket=${encodeURIComponent(ticket)}`,
    onMessage: (data) => {
      const parsed = data as MessageNotification;
      listenersRef.current.forEach((listener) => {
        try { listener(parsed); } catch { /* ignore listener errors */ }
      });
    },
  });

  return { connected, everConnected, onNotification };
}
