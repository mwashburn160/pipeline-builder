// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import { ApiError } from '../errors';
import type { ApiResponse, Message, MessageType, MessagePriority } from '@/types';

export function messagesApi(core: ApiCore) {
  return {
    // ============================================
    // Message endpoints
    // ============================================

    /**
     * Exchange JWT for a short-lived, single-use SSE ticket (avoids putting
     * JWT in the query string).
     *
     * Intentional exception to the envelope-return contract: returns the
     * unwrapped ticket string so the only caller (`useMessageNotifications`)
     * can pipe it straight into `new EventSource(...?ticket=...)`. If the
     * backend ever responds 2xx without a ticket payload we treat that as
     * a 500 — there is no useful "absent ticket" success branch.
     */
    getNotificationTicket: async (): Promise<string> => {
      const res = await core.request<ApiResponse<{ ticket: string }>>('/api/messages/notifications/ticket', { method: 'POST' });
      if (!res.data?.ticket) throw new ApiError('Failed to obtain notification ticket', 500);
      return res.data.ticket;
    },

    /** List inbox messages (root messages only), optionally filtered by type */
    getMessages: async (params?: { messageType?: MessageType; limit?: number; offset?: number; sortBy?: string; sortOrder?: string }) => {
      return core.request<ApiResponse<{ messages: Message[]; pagination?: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/messages${buildQuery(params)}`);
    },

    /** Get unread message count */
    getUnreadCount: async () => {
      return core.request<ApiResponse<{ count: number }>>('/api/messages/unread/count');
    },

    /** Get all messages in a thread */
    getThread: async (id: string) => {
      return core.request<ApiResponse<{ messages: Message[] }>>(`/api/messages/${id}/thread`);
    },

    /** Send a new message (announcement or conversation) */
    sendMessage: async (data: {
      recipientOrgId: string;
      messageType: MessageType;
      subject: string;
      content: string;
      priority?: MessagePriority;
      channel?: string;
    }) => {
      return core.request<ApiResponse<Message>>('/api/messages', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Reply to a message thread */
    replyToMessage: async (id: string, content: string) => {
      return core.request<ApiResponse<Message>>(`/api/messages/${id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
    },

    /** Mark a message as read */
    markMessageAsRead: async (id: string) => {
      return core.request<ApiResponse<{ message: Message }>>(`/api/messages/${id}/read`, {
        method: 'PUT',
      });
    },

    /** Mark all messages in a thread as read */
    markThreadAsRead: async (id: string) => {
      return core.request<ApiResponse<{ updated: number }>>(`/api/messages/${id}/thread/read`, {
        method: 'PUT',
      });
    },

    /** Delete a message (soft delete) */
    deleteMessage: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/messages/${id}`, {
        method: 'DELETE',
      });
    },
  };
}
