// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  getParam,
  requirePermission,
  sendEntityNotFound,
  errorMessage,
  validateBody,
  MessageEditSchema,
} from '@pipeline-builder/api-core';
import { withRoute, createAuthenticatedWithOrgRoute } from '@pipeline-builder/api-server';
import type { RouteContext, SSEManager } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { enrichOneWithOrgNames } from '../helpers/org-names.js';
import { messageService } from '../services/message-service.js';

/**
 * Tell the org's clients their unread badge is stale.
 *
 * Signal only — the COUNT is deliberately NOT in the payload. The SSE fan-out
 * is ORG-scoped (there is no per-user channel), while `getUnreadCount` is
 * viewer-scoped: it honours the per-user rung, so a message targeted at one
 * member is unread for them alone. Putting the reader's number on the org
 * channel would overwrite every other member's badge with a count that was
 * never theirs, so each client refetches its own.
 *
 * Best-effort: a failed push must not fail the read that already committed.
 */
function signalUnreadCountChanged(sseManager: SSEManager, orgId: string, log: RouteContext['ctx']['log']): void {
  try {
    sseManager.send(orgId, 'MESSAGE', 'Unread count changed', { action: 'UNREAD_COUNT' as const });
  } catch (err) {
    log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) });
  }
}

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

  // PATCH /messages/:id — Edit a sent message's content (author-only, enforced
  // in the service). Requires messages:write. Only the body is mutable.
  router.patch('/:id', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:write'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, MessageEditSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

    ctx.log('INFO', 'Editing message', { id });

    const updated = await messageService.editContent(id, orgId, userId, validation.value.content);
    // Null = not the author / not found / soft-deleted. Return 404 (don't leak
    // whether a message the caller can't edit exists) rather than a 403.
    if (!updated) return sendEntityNotFound(res, 'Message');

    ctx.log('COMPLETED', 'Message edited', { id });

    // Notify the other party's org so an open thread refreshes to the new text.
    // Best-effort; the edit already persisted. Carries no content (the client
    // refetches — server-side visibility still gates who can read it).
    try {
      const audienceOrg = updated.recipientOrgId.toLowerCase() === orgId
        ? updated.orgId.toLowerCase()
        : updated.recipientOrgId.toLowerCase();
      if (audienceOrg && audienceOrg !== '*') {
        sseManager.send(audienceOrg, 'MESSAGE', 'Message edited', {
          action: 'MESSAGE_EDITED' as const,
          messageId: updated.id,
          threadId: updated.threadId ?? updated.id,
        });
      }
    } catch (err) {
      ctx.log('WARN', 'Failed to send SSE notification', { error: errorMessage(err) });
    }

    return sendSuccess(res, 200, { message: await enrichOneWithOrgNames(updated) }, 'Message updated');
  }));

  // PUT /messages/:id/read — Mark message as read (messaging read floor)
  router.put('/:id/read', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Marking message as read', { id });

    const message = await messageService.markAsRead(id, orgId, userId);
    if (!message) {
      return sendEntityNotFound(res, 'Message');
    }

    ctx.log('COMPLETED', 'Message marked as read', { id });

    signalUnreadCountChanged(sseManager, orgId, ctx.log);

    return sendSuccess(res, 200, { message: await enrichOneWithOrgNames(message) }, 'Message marked as read');
  }));

  // PUT /messages/:id/thread/read — Mark entire thread as read (messaging read floor)
  router.put('/:id/thread/read', ...createAuthenticatedWithOrgRoute(), requirePermission('messages:read'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Marking thread as read', { threadId: id });

    // Also mark the root message as read — null result means it was already read,
    // so it doesn't contribute to the updated count.
    const root = await messageService.markAsRead(id, orgId, userId);
    const updatedMessages = await messageService.markThreadAsRead(id, orgId, userId);
    const total = updatedMessages.length + (root ? 1 : 0);

    ctx.log('COMPLETED', 'Thread marked as read', { threadId: id, count: total });

    signalUnreadCountChanged(sseManager, orgId, ctx.log);

    return sendSuccess(res, 200, { updated: total }, 'Thread marked as read');
  }));

  return router;
}
