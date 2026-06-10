// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendSuccess,
  sendPaginatedNested,
  ErrorCode,
  parsePaginationParams,
  getParam,
  validateQuery,
  MessageFilterSchema,
  sendEntityNotFound,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, incrementQuotaFromCtx, createProtectedRoute } from '@pipeline-builder/api-server';
import type { MessageFilter } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
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
  router.get('/', ...protect, withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);

    // Validate query params with Zod schema
    const validation = validateQuery(req, MessageFilterSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const { messageType, priority, channel, isRead, threadId } = validation.value;

    ctx.log('INFO', 'Fetching messages inbox', { orgId, messageType, channel, isRead });

    // `threadId === 'root'` (sentinel) or `null` both mean "root messages only".
    // Any UUID value is forwarded literally to filter replies in a thread.
    const resolvedThreadId = threadId === 'root' || threadId === null ? null : threadId;

    const filter: Partial<MessageFilter> = {
      isActive: true,
      threadId: resolvedThreadId ?? null,
      ...(messageType && { messageType }),
      ...(priority && { priority }),
      ...(channel && { channel }),
      ...(isRead !== undefined && { isRead }),
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

  // GET /messages/announcements — List announcements
  router.get('/announcements', ...protect, withRoute(async ({ req, res, ctx, orgId }) => {
    ctx.log('INFO', 'Fetching announcements', { orgId });
    const announcements = await messageService.findAnnouncements(orgId);

    ctx.log('COMPLETED', 'Announcements fetched', { count: announcements.length });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendSuccess(res, 200, { messages: announcements });
  }));

  // GET /messages/conversations — List conversations
  router.get('/conversations', ...protect, withRoute(async ({ req, res, ctx, orgId }) => {
    ctx.log('INFO', 'Fetching conversations', { orgId });
    const conversations = await messageService.findConversations(orgId);

    ctx.log('COMPLETED', 'Conversations fetched', { count: conversations.length });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendSuccess(res, 200, { messages: conversations });
  }));

  // GET /messages/unread/count — Get unread count
  router.get('/unread/count', ...protect, withRoute(async ({ res, ctx, orgId }) => {
    ctx.log('INFO', 'Fetching unread count', { orgId });

    const count = await messageService.getUnreadCount(orgId);

    ctx.log('COMPLETED', 'Unread count fetched', { count });

    return sendSuccess(res, 200, { count });
  }));

  // GET /messages/:id — Get single message
  router.get('/:id', ...protect, withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const message = await messageService.findById(id, orgId);
    if (!message) {
      return sendEntityNotFound(res, 'Message');
    }

    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendSuccess(res, 200, { message });
  }));

  // GET /messages/:id/thread — Get thread messages
  router.get('/:id/thread', ...protect, withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Fetching thread', { threadId: id });

    // Get the root message first
    const rootMessage = await messageService.findById(id, orgId);
    if (!rootMessage) {
      return sendEntityNotFound(res, 'Thread');
    }

    // Get all replies in the thread
    const replies = await messageService.findThreadMessages(id, orgId);

    // Combine root + replies, sorted by creation date
    const thread = [rootMessage, ...replies].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    ctx.log('COMPLETED', 'Thread fetched', { count: thread.length });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

    return sendSuccess(res, 200, { messages: thread });
  }));

  return router;
}
