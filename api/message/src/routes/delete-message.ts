/**
 * @module routes/delete-message
 * @description Express route for soft-deleting messages, restricted to system admins or the original message sender.
 */

import {
  sendError,
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  isSystemAdmin,
  getParam,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { sendMessageNotFound } from '../helpers/message-helpers';
import { messageService } from '../services/message-service';

/**
 * Create delete routes for the message service.
 *
 * Routes:
 *   DELETE /messages/:id — Soft delete a message (admin only)
 */
export function createDeleteMessageRoutes(): Router {
  const router = Router();

  // DELETE /messages/:id — Soft delete a message
  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    // System admins can delete any message
    if (!isSystemAdmin(req)) {
      // Non-admins can only self-delete root messages with no replies
      const message = await messageService.findById(id, orgId);
      if (!message) {
        return sendMessageNotFound(res);
      }
      if (message.createdBy !== userId) {
        return sendError(res, 403, 'Only admins or the message sender can delete messages', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
      if (message.threadId) {
        return sendError(res, 403, 'Only root messages can be deleted by non-admins', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
    }

    ctx.log('INFO', 'Deleting message', { id });

    const deleted = await messageService.delete(id, orgId, userId);
    if (!deleted) {
      return sendMessageNotFound(res);
    }

    // Cascade soft-delete to all replies if this is a root message
    if (!deleted.threadId) {
      await messageService.deleteThread(id, userId);
    }

    ctx.log('COMPLETED', 'Message deleted', { id });

    return sendSuccess(res, 200, undefined, 'Message deleted successfully');
  }));

  return router;
}
