import {
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  parsePaginationParams,
  getParam,
  validateQuery,
  MessageFilterSchema,
  incrementQuota,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import type { QuotaService } from '@mwashburn160/api-server';
import type { MessageFilter } from '@mwashburn160/pipeline-core';
import { Router } from 'express';
import { sendMessageNotFound, sendThreadNotFound } from '../helpers/message-helpers';
import { messageService } from '../services/message-service';

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

  // GET /messages — List inbox (root messages)
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);

    // Validate query params with Zod schema
    const validation = validateQuery(req, MessageFilterSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const { messageType, priority } = validation.value;

    ctx.log('INFO', 'Fetching messages inbox', { orgId, messageType });

    const filter: Partial<MessageFilter> = {
      isActive: true,
      threadId: null, // SQL-level IS NULL — root messages only
      ...(messageType && { messageType }),
      ...(priority && { priority }),
    };

    const result = await messageService.findPaginated(
      filter,
      orgId,
      { limit, offset, sortBy: sortBy || 'createdAt', sortOrder: sortOrder || 'desc' },
    );

    ctx.log('COMPLETED', 'Messages fetched', { count: result.data.length, total: result.total });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, {
      messages: result.data,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
      },
    });
  }));

  // GET /messages/announcements — List announcements
  router.get('/announcements', withRoute(async ({ req, res, ctx, orgId }) => {
    ctx.log('INFO', 'Fetching announcements', { orgId });
    const announcements = await messageService.findAnnouncements(orgId);

    ctx.log('COMPLETED', 'Announcements fetched', { count: announcements.length });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { messages: announcements });
  }));

  // GET /messages/conversations — List conversations
  router.get('/conversations', withRoute(async ({ req, res, ctx, orgId }) => {
    ctx.log('INFO', 'Fetching conversations', { orgId });
    const conversations = await messageService.findConversations(orgId);

    ctx.log('COMPLETED', 'Conversations fetched', { count: conversations.length });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { messages: conversations });
  }));

  // GET /messages/unread/count — Get unread count
  router.get('/unread/count', withRoute(async ({ res, ctx, orgId }) => {
    ctx.log('INFO', 'Fetching unread count', { orgId });

    const count = await messageService.getUnreadCount(orgId);

    ctx.log('COMPLETED', 'Unread count fetched', { count });

    return sendSuccess(res, 200, { count });
  }));

  // GET /messages/:id — Get single message
  router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const message = await messageService.findById(id, orgId);
    if (!message) {
      return sendMessageNotFound(res);
    }

    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { message });
  }));

  // GET /messages/:id/thread — Get thread messages
  router.get('/:id/thread', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Fetching thread', { threadId: id });

    // Get the root message first
    const rootMessage = await messageService.findById(id, orgId);
    if (!rootMessage) {
      return sendThreadNotFound(res);
    }

    // Get all replies in the thread
    const replies = await messageService.findThreadMessages(id, orgId);

    // Combine root + replies, sorted by creation date
    const thread = [rootMessage, ...replies].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    ctx.log('COMPLETED', 'Thread fetched', { count: thread.length });
    incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', ctx.log.bind(null, 'WARN'));

    return sendSuccess(res, 200, { messages: thread });
  }));

  return router;
}
