/**
 * @module routes/read-messages
 * @description Express routes for reading messages, including inbox listing, announcements, conversations, unread counts, and thread retrieval.
 */

import {
  sendBadRequest,
  sendInternalError,
  sendSuccess,
  errorMessage,
  ErrorCode,
  parsePaginationParams,
  getParam,
  validateQuery,
  MessageFilterSchema,
} from '@mwashburn160/api-core';
import { getContext } from '@mwashburn160/api-server';
import type { QuotaService } from '@mwashburn160/api-server';
import type { MessageFilter } from '@mwashburn160/pipeline-core';
import { Router, Request, Response } from 'express';
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
  router.get('/', async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const orgId = ctx.identity.orgId?.toLowerCase() || '';

    try {
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
      void quotaService.increment(orgId, 'apiCalls', req.headers.authorization || '');

      return sendSuccess(res, 200, {
        messages: result.data,
        pagination: {
          total: result.total,
          limit: result.limit,
          offset: result.offset,
          hasMore: result.hasMore,
        },
      });
    } catch (error) {
      ctx.log('ERROR', 'Failed to fetch messages', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  // GET /messages/announcements — List announcements
  router.get('/announcements', async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const orgId = ctx.identity.orgId?.toLowerCase() || '';

    try {
      ctx.log('INFO', 'Fetching announcements', { orgId });
      const announcements = await messageService.findAnnouncements(orgId);

      ctx.log('COMPLETED', 'Announcements fetched', { count: announcements.length });
      void quotaService.increment(orgId, 'apiCalls', req.headers.authorization || '');

      return sendSuccess(res, 200, { messages: announcements });
    } catch (error) {
      ctx.log('ERROR', 'Failed to fetch announcements', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  // GET /messages/conversations — List conversations
  router.get('/conversations', async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const orgId = ctx.identity.orgId?.toLowerCase() || '';

    try {
      ctx.log('INFO', 'Fetching conversations', { orgId });
      const conversations = await messageService.findConversations(orgId);

      ctx.log('COMPLETED', 'Conversations fetched', { count: conversations.length });
      void quotaService.increment(orgId, 'apiCalls', req.headers.authorization || '');

      return sendSuccess(res, 200, { messages: conversations });
    } catch (error) {
      ctx.log('ERROR', 'Failed to fetch conversations', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  // GET /messages/unread/count — Get unread count
  router.get('/unread/count', async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const orgId = ctx.identity.orgId?.toLowerCase() || '';

    try {
      ctx.log('INFO', 'Fetching unread count', { orgId });

      const count = await messageService.getUnreadCount(orgId);

      ctx.log('COMPLETED', 'Unread count fetched', { count });

      return sendSuccess(res, 200, { count });
    } catch (error) {
      ctx.log('ERROR', 'Failed to get unread count', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  // GET /messages/:id — Get single message
  router.get('/:id', async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      const message = await messageService.findById(id, orgId);
      if (!message) {
        return sendMessageNotFound(res);
      }

      void quotaService.increment(orgId, 'apiCalls', req.headers.authorization || '');

      return sendSuccess(res, 200, { message });
    } catch (error) {
      ctx.log('ERROR', 'Failed to get message', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  // GET /messages/:id/thread — Get thread messages
  router.get('/:id/thread', async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
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
      void quotaService.increment(orgId, 'apiCalls', req.headers.authorization || '');

      return sendSuccess(res, 200, { messages: thread });
    } catch (error) {
      ctx.log('ERROR', 'Failed to fetch thread', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
