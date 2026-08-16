// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery, API_URL } from '../util';
import { ApiError } from '../errors';
import type { ApiResponse, Message, MessageAttachment, MessageType, MessagePriority } from '@/types';

/**
 * Fresh idempotency key for a mutation. The message service runs POST
 * /messages + /:id/reply through the shared idempotency middleware, which
 * dedupes retries carrying the SAME `Idempotency-Key`. Generating one per send
 * makes a request that is transparently retried (e.g. the api-core 401→refresh
 * recursion, which reuses the same headers) land as ONE message instead of two.
 */
function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

    /** List inbox messages (root messages only), optionally filtered by type or a free-text search */
    getMessages: async (params?: { messageType?: MessageType; search?: string; limit?: number; offset?: number; sortBy?: string; sortOrder?: string }) => {
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
      /** Optional per-user target within recipientOrgId (conversation-only). */
      recipientUserId?: string;
      messageType: MessageType;
      subject: string;
      content: string;
      priority?: MessagePriority;
      channel?: string;
      /** Ids of previously-uploaded attachments to link to this message. */
      attachmentIds?: string[];
      /** Override the auto-generated idempotency key to make a client-level
       *  retry of the SAME logical send collapse to one message. */
      idempotencyKey?: string;
    }) => {
      const { idempotencyKey, ...body } = data;
      return core.request<ApiResponse<Message>>('/api/messages', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey ?? newIdempotencyKey() },
        body: JSON.stringify(body),
      });
    },

    /** Reply to a message thread */
    replyToMessage: async (id: string, content: string, attachmentIds?: string[], idempotencyKey?: string) => {
      return core.request<ApiResponse<Message>>(`/api/messages/${id}/reply`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey ?? newIdempotencyKey() },
        body: JSON.stringify({ content, ...(attachmentIds?.length ? { attachmentIds } : {}) }),
      });
    },

    /** Edit a sent message's content (author-only; enforced server-side). */
    editMessage: async (id: string, content: string) => {
      return core.request<ApiResponse<{ message: Message }>>(`/api/messages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      });
    },

    /** Upload one attachment (multipart). Returns its metadata + id; include the
     *  id in a subsequent sendMessage/replyToMessage `attachmentIds`. */
    uploadAttachment: async (file: File, options?: { signal?: AbortSignal }) => {
      await core.ensureFreshToken();
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_URL}/api/messages/attachments`, {
        method: 'POST',
        headers: core.authHeaders(),
        body: formData,
        credentials: 'same-origin',
        signal: options?.signal,
      });
      const data = await response.json().catch(() => ({ message: 'Upload failed', success: false }));
      if (response.status >= 400) {
        throw new ApiError(data.message || 'Upload failed', response.status, data.code);
      }
      return data as ApiResponse<{ attachment: MessageAttachment }>;
    },

    /** List a message's attachment metadata. */
    getMessageAttachments: async (messageId: string) => {
      return core.request<ApiResponse<{ attachments: MessageAttachment[] }>>(`/api/messages/${messageId}/attachments`);
    },

    /** Fetch an attachment's bytes (auth-gated) as a Blob — the caller creates an
     *  object URL for <img>/<a download>, since a bare URL can't carry auth headers.
     *  Pass `thumb` for the downscaled preview (server falls back to the original
     *  when no thumbnail exists). */
    fetchAttachmentBlob: async (id: string, opts?: { thumb?: boolean }): Promise<Blob> => {
      await core.ensureFreshToken();
      const q = opts?.thumb ? '?thumb=1' : '';
      const response = await fetch(`${API_URL}/api/messages/attachments/${id}${q}`, {
        headers: core.authHeaders(),
        credentials: 'same-origin',
      });
      if (response.status >= 400) {
        throw new ApiError('Attachment download failed', response.status);
      }
      return response.blob();
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

    /** List the org's soft-deleted messages (tombstones), most-recent first —
     *  restorable until the retention sweep purges them. Powers the
     *  RecentlyDeletedPanel. */
    listDeletedMessages: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{ messages: Message[] }>>(`/api/messages/deleted${buildQuery(params)}`);
    },

    /** Restore a soft-deleted message (undo delete within the retention window).
     *  Step-up gated (reverses a destructive action): pass the token from
     *  StepUpModal; the api forwards it as the `X-Step-Up-Token` header. */
    restoreMessage: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(`/api/messages/${id}/restore`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },
  };
}
