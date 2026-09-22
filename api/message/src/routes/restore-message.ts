// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  isSystemAdmin,
  audited,
  loadAndRestore,
  actorId,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { authorizeOwnRootMessage } from '../helpers/message-authz.js';
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

  router.post('/:id/restore', audited('message.restore'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // Sysadmins moderate cross-org (no org pin, matching deleteAsSysadmin);
    // non-admins stay pinned to their org.
    const result = await loadAndRestore(req, res, messageService, {
      orgId,
      userId,
      label: 'Message',
      scopeOrgId: isSystemAdmin(req) ? undefined : orgId,
      authorize: (existing, rq, rs) => authorizeOwnRootMessage(rq, rs, existing, userId, 'restore'),
    });
    if (!result) return;
    const { restored } = result;

    ctx.log('COMPLETED', 'Message restored', { id: restored.id });

    // Audit — SAFE METADATA ONLY (never the body). Fire-and-forget.
    recordAudit({
      action: 'message.restore',
      actorId: actorId({ userId }),
      orgId,
      affectedOrgId: restored.orgId,
      targetType: 'message',
      targetId: restored.id,
      details: { isAnnouncement: restored.messageType === 'announcement' },
    });

    return sendSuccess(res, 200, undefined, 'Message restored successfully');
  }));

  return router;
}
