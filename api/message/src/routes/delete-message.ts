// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendError,
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  isSystemAdmin,
  getParam,
  createLogger,
  sendEntityNotFound,
  errorMessage,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { messageService } from '../services/message-service';

const logger = createLogger('delete-message');

/**
 * Create delete routes for the message service.
 *
 * Routes:
 *   DELETE /messages/:id — Soft delete a message (admin only)
 * @param sseManager - SSE manager for pushing real-time notifications
 */
export function createDeleteMessageRoutes(sseManager: SSEManager): Router {
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
        return sendEntityNotFound(res, 'Message');
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
      return sendEntityNotFound(res, 'Message');
    }

    // Cascade soft-delete to all replies if this is a root message.
    // Pass orgId so the cascade scopes to the caller's tenant.
    if (!deleted.threadId) {
      await messageService.deleteThread(id, userId, orgId);
    }

    ctx.log('COMPLETED', 'Message deleted', { id });

    // Notify the other party about the deletion
    try {
      if (deleted.recipientOrgId && deleted.recipientOrgId !== '*') {
        const otherOrgId = deleted.orgId.toLowerCase() === orgId
          ? deleted.recipientOrgId.toLowerCase()
          : deleted.orgId.toLowerCase();

        sseManager.send(otherOrgId, 'MESSAGE', 'Message deleted', {
          action: 'MESSAGE_DELETED' as const,
          messageId: id,
          threadId: deleted.threadId || undefined,
        });
      }
    } catch (err) {
      logger.warn('Failed to send SSE notification', { error: errorMessage(err) });
    }

    return sendSuccess(res, 200, undefined, 'Message deleted successfully');
  }));

  return router;
}
