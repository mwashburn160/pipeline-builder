/**
 * @module routes/update-message
 * @description Express routes for updating messages, including marking individual messages and entire threads as read.
 */

import {
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  getParam,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { sendMessageNotFound } from '../helpers/message-helpers';
import { messageService } from '../services/message-service';

/**
 * Create update routes for the message service.
 *
 * Routes:
 *   PUT /messages/:id/read        — Mark a single message as read
 *   PUT /messages/:id/thread/read — Mark all messages in a thread as read
 */
export function createUpdateMessageRoutes(): Router {
  const router = Router();

  // PUT /messages/:id/read — Mark message as read
  router.put('/:id/read', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Marking message as read', { id });

    const message = await messageService.markAsRead(id, orgId, userId);
    if (!message) {
      return sendMessageNotFound(res);
    }

    ctx.log('COMPLETED', 'Message marked as read', { id });

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

    return sendSuccess(res, 200, { updated: updatedMessages.length + 1 }, 'Thread marked as read');
  }));

  return router;
}
