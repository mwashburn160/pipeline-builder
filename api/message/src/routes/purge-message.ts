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
 * Purge route — manual, on-demand PERMANENT hard-delete of an already
 * soft-deleted message tombstone. This finalizes immediately what the retention
 * sweep would otherwise do at the tombstone's `purge_after` deadline; the sweep
 * still exists for tombstones no one purges by hand.
 *
 * Expects `createAuthenticatedWithOrgRoute()` + `requirePermission('messages:write')`
 * + `requireStepUp` as mount-level middleware in the parent — the SAME authority
 * as restore, including the step-up (password re-verify) gate, since purge is a
 * destructive finalization. The frontend sends the step-up token in the same
 * header restore uses. Access mirrors restore/delete: sysadmins moderate
 * cross-org (no org pin); non-admins may purge only their own root-message
 * tombstones.
 *
 * 404 when the id is unknown or NOT currently soft-deleted (a live message can
 * only be soft-deleted first, never purged directly). Attachment/blob teardown
 * rides the shared `onBeforePurge` hook inside the purge transaction.
 */
export function createPurgeMessageRoutes(): Router {
  const router = Router();

  router.post('/:id/purge', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Message ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const sysadmin = isSystemAdmin(req);

    // Load the TOMBSTONE (soft-deleted only). Sysadmins span orgs (no org pin);
    // non-admins stay org-scoped. A live (non-deleted) message never matches, so
    // purge can only ever finalize an already-soft-deleted row.
    const existing = sysadmin
      ? await messageService.findDeletedById(id)
      : await messageService.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Message');

    if (!sysadmin) {
      if (existing.createdBy !== userId) {
        return sendError(res, 403, 'Only admins or the message sender can purge messages', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
      if (existing.threadId) {
        return sendError(res, 403, 'Only root messages can be purged by non-admins', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
    }

    ctx.log('INFO', 'Purging message', { id });

    // Sysadmin purge drops the org pin (cross-org moderation, matching
    // deleteAsSysadmin); non-admins stay pinned to their org. Reuses the
    // retention sweep's hard-delete machinery for a single id.
    const purged = await messageService.purgeById(id, sysadmin ? '' : orgId);
    if (!purged) return sendEntityNotFound(res, 'Message');

    ctx.log('COMPLETED', 'Message purged', { id });

    // Audit — SAFE METADATA ONLY (never the body). Fire-and-forget.
    getAuditClient().record({
      action: 'message.purge',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'message',
      targetId: existing.id,
      details: { isAnnouncement: existing.messageType === 'announcement' },
    }, 'message');

    return sendSuccess(res, 200, {}, 'Message permanently deleted.');
  }));

  return router;
}
