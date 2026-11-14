// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendError,
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
  validateBody,
  MessageBulkIdsSchema,
} from '@pipeline-builder/api-core';
import { withRoute, createAuthenticatedWithOrgRoute, incCounter } from '@pipeline-builder/api-server';
import type { RouteContext, SSEManager } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { ownRootMessageRefusal } from '../helpers/message-authz.js';
import { signalUnreadCountChanged } from '../helpers/new-message.js';
import { messageService } from '../services/message-service.js';

/** What happened to one id: deleted, not visible to the caller, or refused. */
type DeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'not_found' }
  | { kind: 'forbidden'; reason: string };

/**
 * Soft-delete ONE message exactly as `DELETE /messages/:id` always has: the
 * ownership check (non-admins: own root only), the reply cascade, the domain
 * metric, a per-message `message.delete` audit row, and the counterparty SSE.
 *
 * Shared by the single and bulk routes so a bulk delete can never be a weaker
 * or differently-audited path than deleting the rows one at a time.
 */
async function deleteOne(
  sseManager: SSEManager,
  ctx: RouteContext['ctx'],
  id: string,
  orgId: string,
  userId: string,
  sysadmin: boolean,
): Promise<DeleteOutcome> {
  if (!sysadmin) {
    const message = await messageService.findById(id, orgId);
    if (!message) return { kind: 'not_found' };
    const refusal = ownRootMessageRefusal(message, userId, 'delete');
    if (refusal) return { kind: 'forbidden', reason: refusal };
  }

  ctx.log('INFO', 'Deleting message', { id });

  // Sysadmins moderate cross-org: drop the org pin so any conversation root/reply
  // is deletable (the reply-cascade below already sweeps cross-org). Non-admins
  // stay org-scoped via the base delete.
  const deleted = sysadmin
    ? await messageService.deleteAsSysadmin(id, userId)
    : await messageService.delete(id, orgId, userId);
  if (!deleted) return { kind: 'not_found' };

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
  // Fire-and-forget: emission never throws and is not awaited. One row PER
  // MESSAGE even in bulk: a delete is destructive, and the trail must be able
  // to answer "who deleted THIS message" by its id.
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

  return { kind: 'deleted' };
}

/**
 * Create delete routes for the message service.
 *
 * Routes:
 *   DELETE /messages/:id    — Soft delete a message (sender's own root, or sysadmin)
 *   POST   /messages/delete — Soft delete ticked messages, same rule per row
 * @param sseManager - SSE manager for pushing real-time notifications
 */
export function createDeleteMessageRoutes(sseManager: SSEManager): Router {
  const router = Router();

  // DELETE /messages/:id — Soft delete a message. Requires the messaging write
  // capability (parity with create/reply); the ownership check in `deleteOne`
  // further restricts non-admins to their own root messages — both must hold.
  router.delete('/:id', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), audited('message.delete'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const outcome = await deleteOne(sseManager, ctx, id, orgId, userId, isSystemAdmin(req));
    if (outcome.kind === 'not_found') return sendEntityNotFound(res, 'Message');
    if (outcome.kind === 'forbidden') return sendError(res, 403, outcome.reason, ErrorCode.INSUFFICIENT_PERMISSIONS);

    // A deleted unread message (or its unread replies) leaves the deleting org's count.
    signalUnreadCountChanged(sseManager, orgId, ctx.log);
    return sendSuccess(res, 200, undefined, 'Message deleted successfully');
  }));

  /**
   * POST /messages/delete — soft-delete the ticked messages in ONE request.
   *
   * Same gate and same per-row rule as `DELETE /messages/:id` (it runs the same
   * `deleteOne`), so it is a batching of that route, not a new power: a
   * non-admin's selection may only contain their own root messages. A row that
   * fails the rule is REPORTED, not fatal — the rest still go — and the
   * response says exactly which ids were refused or not found, so the UI can
   * tell the person what was left behind. One request is one apiCalls unit.
   *
   * Sequential, not parallel: each delete cascades its thread in its own
   * transaction, and a 200-row burst of concurrent cascades would contend on
   * the same table for no gain the person can see.
   */
  router.post('/delete', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), audited('message.delete'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, MessageBulkIdsSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const ids = [...new Set(validation.value.ids)];
    const sysadmin = isSystemAdmin(req);

    const deleted: string[] = [];
    const notFound: string[] = [];
    const refused: string[] = [];
    for (const id of ids) {
      const outcome = await deleteOne(sseManager, ctx, id, orgId, userId, sysadmin);
      if (outcome.kind === 'deleted') deleted.push(id);
      else if (outcome.kind === 'not_found') notFound.push(id);
      else refused.push(id);
    }

    if (deleted.length > 0) signalUnreadCountChanged(sseManager, orgId, ctx.log);
    return sendSuccess(
      res, 200, { deleted, notFound, refused },
      `Deleted ${deleted.length} message${deleted.length === 1 ? '' : 's'}`,
    );
  }));

  return router;
}
