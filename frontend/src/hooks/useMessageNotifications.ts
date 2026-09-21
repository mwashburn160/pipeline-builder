// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSE-based hook for real-time message notifications. Connects to the message
 * service and receives push notifications for new messages, deletions, and
 * unread-count updates. The ticket exchange + reconnect/backoff live in
 * {@link useTicketedSSE}; this hook adds the unread-count state + a listener
 * subscription on top.
 */
import { useState, useRef, useCallback } from 'react';
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
 * @returns unreadCount state, connection status, and notification subscription
 */
export function useMessageNotifications(orgId: string | null) {
  const [unreadCount, setUnreadCount] = useState(0);
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
      if (parsed.data?.action === 'UNREAD_COUNT') {
        // REFETCH rather than trust the frame. The unread count is viewer-scoped
        // (a message targeted at one member is unread for them alone) but the
        // SSE channel is org-scoped, so the server cannot put a number in here
        // that is correct for every recipient — it used to send the reader's,
        // which overwrote every other member's badge with someone else's count.
        // The frame is a signal that something changed; each client asks for its
        // own number. Failures are ignored: the badge is non-critical.
        void api.getUnreadCount()
          .then((result) => setUnreadCount(result.data?.count ?? 0))
          .catch(() => { /* keep the last known count */ });
      }
      listenersRef.current.forEach((listener) => {
        try { listener(parsed); } catch { /* ignore listener errors */ }
      });
    },
  });

  return { unreadCount, setUnreadCount, connected, everConnected, onNotification };
}
