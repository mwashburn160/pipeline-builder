import {
  sendBadRequest,
  sendInternalError,
  errorMessage,
  ErrorCode,
  getParam,
} from '@mwashburn160/api-core';
import { Router, Request, Response } from 'express';
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
  router.put('/:id/read', async (req: Request, res: Response) => {
    const ctx = req.context!;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || 'unknown';
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      ctx.log('INFO', 'Marking message as read', { id });

      const message = await messageService.markAsRead(id, orgId, userId);
      if (!message) {
        return sendMessageNotFound(res);
      }

      ctx.log('COMPLETED', 'Message marked as read', { id });

      return res.status(200).json({
        success: true,
        statusCode: 200,
        data: message,
        message: 'Message marked as read',
      });
    } catch (error) {
      ctx.log('ERROR', 'Failed to mark message as read', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  // PUT /messages/:id/thread/read — Mark entire thread as read
  router.put('/:id/thread/read', async (req: Request, res: Response) => {
    const ctx = req.context!;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || 'unknown';
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      ctx.log('INFO', 'Marking thread as read', { threadId: id });

      // Also mark the root message as read
      await messageService.markAsRead(id, orgId, userId);
      const updatedMessages = await messageService.markThreadAsRead(id, orgId, userId);

      ctx.log('COMPLETED', 'Thread marked as read', { threadId: id, count: updatedMessages.length + 1 });

      return res.status(200).json({
        success: true,
        statusCode: 200,
        data: { updated: updatedMessages.length + 1 },
        message: 'Thread marked as read',
      });
    } catch (error) {
      ctx.log('ERROR', 'Failed to mark thread as read', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
