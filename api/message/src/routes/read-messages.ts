// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendSuccess,
  sendPaginatedNested,
  ErrorCode,
  parsePaginationParams,
  getParam,
  requirePermission,
  validateQuery,
  MessageFilterSchema,
  sendEntityNotFound,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, incrementQuotaFromCtx, createProtectedRoute } from '@pipeline-builder/api-server';
import type { MessageFilter } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { attachmentService } from '../services/attachment-service.js';
import { messageService } from '../services/message-service.js';

/**
 * Create read routes for the message service.
 *
 * Routes:
 *   GET /messages              — List inbox (root messages), paginated
 *   GET /messages/announcements — List announcements only
 *   GET /messages/conversations — List conversations only
 *   GET /messages/unread/count  — Get unread message count
 *   GET /messages/:id           — Get single message by ID
 *   GET /messages/:id/thread    — Get all messages in a thread
 */
export function createReadMessageRoutes(quotaService: QuotaService): Router {
  const router = Router();
  const protect = createProtectedRoute(quotaService, 'apiCalls');

  // GET /messages — List inbox (root messages)
  router.get('/', ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);

    // Validate query params with Zod schema
    const validation = validateQuery(req, MessageFilterSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const { messageType, priority, channel, isRead, threadId, search } = validation.value;

    ctx.log('INFO', 'Fetching messages inbox', { orgId, messageType, channel, isRead, search: search ? '(set)' : undefined });

    // `threadId === 'root'` (sentinel) or `null` both mean "root messages only".
    // Any UUID value is forwarded literally to filter replies in a thread.
    const resolvedThreadId = threadId === 'root' || threadId === null ? null : threadId;

    const filter: Partial<MessageFilter> = {
      isActive: true,
      threadId: resolvedThreadId ?? null,
      // Scope per-user targeted messages to this viewer (org-wide rows are
      // unaffected; a message addressed to another member won't surface here).
      ...(userId && { viewerUserId: userId }),
      ...(messageType && { messageType }),
      ...(priority && { priority }),
      ...(channel && { channel }),
      ...(isRead !== undefined && { isRead }),
      ...(search && { search }),
    };

    const result = await messageService.findPaginated(
      filter,
      orgId,
      { limit, offset, sortBy: sortBy || 'createdAt', sortOrder: sortOrder || 'desc' },
    );

    ctx.log('COMPLETED', 'Messages fetched', { count: result.data.length, total: result.total });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendPaginatedNested(res, 'messages', result.data, {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore,
    });
  }));

  // GET /messages/announcements — List announcements (paginated + hard-capped,
  // mirroring the `/` inbox — the service clamps limit to MAX_PAGE_LIMIT so this
  // can never fetch/cache an unbounded set).
  router.get('/announcements', ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);
    ctx.log('INFO', 'Fetching announcements', { orgId });
    const result = await messageService.findAnnouncements(orgId, {
      limit, offset, sortBy: sortBy || 'createdAt', sortOrder: sortOrder || 'desc',
    });

    ctx.log('COMPLETED', 'Announcements fetched', { count: result.data.length });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendPaginatedNested(res, 'messages', result.data, {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore,
    });
  }));

  // GET /messages/conversations — List conversations (paginated + hard-capped).
  router.get('/conversations', ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);
    ctx.log('INFO', 'Fetching conversations', { orgId });
    const result = await messageService.findConversations(orgId, {
      limit, offset, sortBy: sortBy || 'createdAt', sortOrder: sortOrder || 'desc',
    }, userId);

    ctx.log('COMPLETED', 'Conversations fetched', { count: result.data.length });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendPaginatedNested(res, 'messages', result.data, {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore,
    });
  }));

  // GET /messages/unread/count — Get unread count
  router.get('/unread/count', ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    ctx.log('INFO', 'Fetching unread count', { orgId });

    const count = await messageService.getUnreadCount(orgId, userId);

    // Parity with every other read handler — the frontend polls this frequently,
    // so omitting the increment systematically under-counts apiCalls.
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    ctx.log('COMPLETED', 'Unread count fetched', { count });

    return sendSuccess(res, 200, { count });
  }));

  // GET /messages/deleted — org's soft-deleted message tombstones (most recent
  // first), powering the "recently deleted" restore UI. Registered BEFORE `/:id`
  // so the literal path isn't swallowed by the id matcher.
  router.get('/deleted', ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const deleted = await messageService.findDeleted(orgId, { limit, offset });

    ctx.log('COMPLETED', 'Listed deleted messages', { count: deleted.length });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendSuccess(res, 200, { messages: deleted });
  }));

  // GET /messages/:id — Get single message
  router.get('/:id', ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Viewer-scoped: a per-user targeted message is returned only to its target
    // (plus the sender org / system org), never to other members of the org.
    const message = await messageService.findVisibleById(id, orgId, userId);
    if (!message) {
      return sendEntityNotFound(res, 'Message');
    }

    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendSuccess(res, 200, { message });
  }));

  // GET /messages/:id/thread — Get thread messages
  router.get('/:id/thread', ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Fetching thread', { threadId: id });

    // Get the root message first (viewer-scoped: a per-user targeted root is
    // only visible to its target, so the thread stays private to them).
    const rootMessage = await messageService.findVisibleById(id, orgId, userId);
    if (!rootMessage) {
      return sendEntityNotFound(res, 'Thread');
    }

    // Get all replies in the thread (same viewer scope as the root).
    const replies = await messageService.findThreadMessages(id, orgId, userId);

    // Combine root + replies, sorted by creation date
    const thread = [rootMessage, ...replies].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    // Embed each message's attachment metadata (one batched query for the whole
    // thread) so the client renders attachments without an N+1 fetch-per-message.
    // Authorized already: the caller passed the viewer-scoped root/reply gates.
    const attRows = await attachmentService.findByMessageIds(thread.map((m) => m.id));
    const byMsg = new Map<string, Array<{ id: string; filename: string; contentType: string; sizeBytes: number }>>();
    for (const a of attRows) {
      if (!a.messageId) continue;
      const list = byMsg.get(a.messageId) ?? [];
      list.push({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes });
      byMsg.set(a.messageId, list);
    }
    const messages = thread.map((m) => ({ ...m, attachments: byMsg.get(m.id) ?? [] }));

    ctx.log('COMPLETED', 'Thread fetched', { count: thread.length });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendSuccess(res, 200, { messages });
  }));

  // GET /messages/:id/attachments — list a message's attachment metadata. Gated
  // on the SAME viewer-scoped visibility as the message itself: a per-user
  // targeted message's attachment list is only visible to its target.
  router.get('/:id/attachments', ...protect, requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const message = await messageService.findVisibleById(id, orgId, userId);
    if (!message) return sendEntityNotFound(res, 'Message');

    const rows = await attachmentService.findByMessageId(id);
    const attachments = rows.map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    }));

    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');
    return sendSuccess(res, 200, { attachments });
  }));

  return router;
}
