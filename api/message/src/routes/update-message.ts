import {
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  getParam,
  createLogger,
  sendEntityNotFound,
  errorMessage,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import type { SSEManager } from '@mwashburn160/api-server';
import { Router } from 'express';
import { messageService } from '../services/message-service';

const logger = createLogger('update-message');

/**
 * Create update routes for the message service.
 *
 * Routes:
 *   PUT /messages/:id/read        — Mark a single message as read
 *   PUT /messages/:id/thread/read — Mark all messages in a thread as read
 * @param sseManager - SSE manager for pushing real-time notifications
 */
export function createUpdateMessageRoutes(sseManager: SSEManager): Router {
  const router = Router();

  // PUT /messages/:id/read — Mark message as read
  router.put('/:id/read', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Marking message as read', { id });

    const message = await messageService.markAsRead(id, orgId, userId);
    if (!message) {
      return sendEntityNotFound(res, 'Message');
    }

    ctx.log('COMPLETED', 'Message marked as read', { id });

    // Push updated unread count to the reader's org
    try {
      const unreadCount = await messageService.getUnreadCount(orgId);
      sseManager.send(orgId, 'MESSAGE', 'Unread count updated', {
        action: 'UNREAD_COUNT' as const,
        unreadCount,
      });
    } catch (err) {
      logger.warn('Failed to send SSE notification', { error: errorMessage(err) });
    }

    return sendSuccess(res, 200, { message }, 'Message marked as read');
  }));

  // PUT /messages/:id/thread/read — Mark entire thread as read
  router.put('/:id/thread/read', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Marking thread as read', { threadId: id });

    // Also mark the root message as read
    await messageService.markAsRead(id, orgId, userId);
    const updatedMessages = await messageService.markThreadAsRead(id, orgId, userId);

    ctx.log('COMPLETED', 'Thread marked as read', { threadId: id, count: updatedMessages.length + 1 });

    // Push updated unread count to the reader's org
    try {
      const unreadCount = await messageService.getUnreadCount(orgId);
      sseManager.send(orgId, 'MESSAGE', 'Unread count updated', {
        action: 'UNREAD_COUNT' as const,
        unreadCount,
      });
    } catch (err) {
      logger.warn('Failed to send SSE notification', { error: errorMessage(err) });
    }

    return sendSuccess(res, 200, { updated: updatedMessages.length + 1 }, 'Thread marked as read');
  }));

  return router;
}
