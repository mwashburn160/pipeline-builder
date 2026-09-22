// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  isSystemAdmin,
  requirePermission,
  audited,
  getParam,
  sendEntityNotFound,
  errorMessage,
  actorId,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute, createAuthenticatedWithOrgRoute, incCounter } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { authorizeOwnRootMessage } from '../helpers/message-authz.js';
import { messageService } from '../services/message-service.js';

/**
 * Create delete routes for the message service.
 *
 * Routes:
 *   DELETE /messages/:id — Soft delete a message (admin only)
 * @param sseManager - SSE manager for pushing real-time notifications
 */
export function createDeleteMessageRoutes(sseManager: SSEManager): Router {
  const router = Router();

  // DELETE /messages/:id — Soft delete a message. Requires the messaging write
  // capability (parity with create/reply); the inline ownership check below
  // further restricts non-admins to their own root messages — both must hold.
  router.delete('/:id', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), audited('message.delete'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const sysadmin = isSystemAdmin(req);

    if (!sysadmin) {
      const message = await messageService.findById(id, orgId);
      if (!message) return sendEntityNotFound(res, 'Message');
      if (!authorizeOwnRootMessage(req, res, message, userId, 'delete')) return;
    }

    ctx.log('INFO', 'Deleting message', { id });

    // Sysadmins moderate cross-org: drop the org pin so any conversation root/reply
    // is deletable (the reply-cascade below already sweeps cross-org). Non-admins
    // stay org-scoped via the base delete.
    const deleted = sysadmin
      ? await messageService.deleteAsSysadmin(id, userId)
      : await messageService.delete(id, orgId, userId);
    if (!deleted) {
      return sendEntityNotFound(res, 'Message');
    }

    // Cascade soft-delete to all replies if this is a root message.
    // Sysadmin deletes drop the tenant scope so replies from both
    // participants are swept.
    if (!deleted.threadId) {
      await messageService.deleteThread(id, userId, orgId, sysadmin);
    }

    ctx.log('COMPLETED', 'Message deleted', { id });

    // Domain metric — a message was deleted. Tagged by action only to keep
    // label cardinality bounded (no orgId/messageId).
    incCounter('message_events_total', { action: 'deleted' });

    // Audit the delete (admin/message-sender action). `details` is SAFE METADATA
    // ONLY (whether the deleted message was an announcement) — never the body.
    // Fire-and-forget: emission never throws and is not awaited.
    recordAudit({
      action: 'message.delete',
      actorId: actorId({ userId }),
      orgId,
      // A sysadmin moderation delete crosses orgs: record whose message it was.
      affectedOrgId: deleted.orgId,
      targetType: 'message',
      targetId: deleted.id,
      details: {
        isAnnouncement: deleted.messageType === 'announcement',
      },
    });

    // Notify the other party (or both, when sysadmin-deleting) about the deletion.
    try {
      if (deleted.recipientOrgId && deleted.recipientOrgId !== '*') {
        const payload = {
          action: 'MESSAGE_DELETED' as const,
          messageId: id,
          threadId: deleted.threadId || undefined,
        };
        if (sysadmin) {
          sseManager.send(deleted.orgId.toLowerCase(), 'MESSAGE', 'Message deleted', payload);
          sseManager.send(deleted.recipientOrgId.toLowerCase(), 'MESSAGE', 'Message deleted', payload);
        } else {
          const otherOrgId = deleted.orgId.toLowerCase() === orgId
            ? deleted.recipientOrgId.toLowerCase()
            : deleted.orgId.toLowerCase();
          sseManager.send(otherOrgId, 'MESSAGE', 'Message deleted', payload);
        }
      }
    } catch (err) {
      ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) });
    }

    return sendSuccess(res, 200, undefined, 'Message deleted successfully');
  }));

  return router;
}
