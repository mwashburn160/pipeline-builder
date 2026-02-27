/**
 * @module routes/delete-message
 * @description Express route for soft-deleting messages, restricted to system admins or the original message sender.
 */

import {
  sendError,
  sendBadRequest,
  sendInternalError,
  sendSuccess,
  errorMessage,
  ErrorCode,
  isSystemAdmin,
  getParam,
} from '@mwashburn160/api-core';
import { getContext } from '@mwashburn160/api-server';
import { Router, Request, Response } from 'express';
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
  router.delete('/:id', async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || 'unknown';
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      // Only admins can delete messages
      if (!isSystemAdmin(req)) {
        // Check if the user is the message sender (allow self-delete)
        const message = await messageService.findById(id, orgId);
        if (!message) {
          return sendMessageNotFound(res);
        }
        if (message.createdBy !== userId) {
          return sendError(res, 403, 'Only admins or the message sender can delete messages', ErrorCode.INSUFFICIENT_PERMISSIONS);
        }
      }

      ctx.log('INFO', 'Deleting message', { id });

      const deleted = await messageService.delete(id, orgId, userId);
      if (!deleted) {
        return sendMessageNotFound(res);
      }

      ctx.log('COMPLETED', 'Message deleted', { id });

      return sendSuccess(res, 200, undefined, 'Message deleted successfully');
    } catch (error) {
      ctx.log('ERROR', 'Failed to delete message', { error: errorMessage(error) });
      return sendInternalError(res, errorMessage(error));
    }
  });

  return router;
}
