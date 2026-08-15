// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendError,
  sendBadRequest,
  sendSuccess,
  ErrorCode,
  isSystemAdmin,
  getParam,
  sendEntityNotFound,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { getAuditClient } from '../services/audit.js';
import { messageService } from '../services/message-service.js';

/**
 * Restore route — undo a soft-delete within the retention window (before the
 * purge sweep hard-deletes the tombstone).
 *
 * Expects `createAuthenticatedWithOrgRoute()` + `requirePermission('messages:write')`
 * + `requireStepUp` as mount-level middleware in the parent (mirrors the delete
 * route's authority, plus a step-up re-verify since restore reverses a
 * destructive action). Access mirrors delete: sysadmins moderate cross-org (no
 * org pin); non-admins may restore only their own root messages.
 *
 * NOTE: restores the single message only — a root's soft-deleted replies are
 * NOT cascaded back (delete cascades via deleteThread; there is no restoreThread).
 */
export function createRestoreMessageRoutes(): Router {
  const router = Router();

  router.post('/:id/restore', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const sysadmin = isSystemAdmin(req);

    // Load the TOMBSTONE. Sysadmins span orgs (no org pin); non-admins stay
    // org-scoped and may only touch their own root messages.
    const existing = sysadmin
      ? await messageService.findDeletedById(id)
      : await messageService.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Message');

    if (!sysadmin) {
      if (existing.createdBy !== userId) {
        return sendError(res, 403, 'Only admins or the message sender can restore messages', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
      if (existing.threadId) {
        return sendError(res, 403, 'Only root messages can be restored by non-admins', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
    }

    ctx.log('INFO', 'Restoring message', { id });

    // Sysadmin restore drops the org pin (cross-org moderation, matching
    // deleteAsSysadmin); non-admins stay pinned to their org.
    const restored = await messageService.restore(id, sysadmin ? '' : orgId, userId);
    if (!restored) return sendEntityNotFound(res, 'Message');

    ctx.log('COMPLETED', 'Message restored', { id });

    // Audit — SAFE METADATA ONLY (never the body). Fire-and-forget.
    getAuditClient().record({
      action: 'message.restore',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: restored.orgId,
      targetType: 'message',
      targetId: restored.id,
      details: { isAnnouncement: restored.messageType === 'announcement' },
    }, 'message');

    return sendSuccess(res, 200, undefined, 'Message restored successfully');
  }));

  return router;
}
