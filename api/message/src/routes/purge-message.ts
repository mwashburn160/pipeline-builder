// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  isSystemAdmin,
  audited,
  loadAndPurge,
  actorId,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { authorizeOwnRootMessage } from '../helpers/message-authz.js';
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

  router.post('/:id/purge', audited('message.purge'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // Only a tombstone loads, so purge can only ever finalize an already
    // soft-deleted row. Sysadmins moderate cross-org (no org pin, matching
    // deleteAsSysadmin); non-admins stay pinned to their org.
    const result = await loadAndPurge(req, res, messageService, {
      orgId,
      userId,
      label: 'Message',
      scopeOrgId: isSystemAdmin(req) ? undefined : orgId,
      authorize: (tombstone, rq, rs) => authorizeOwnRootMessage(rq, rs, tombstone, userId, 'purge'),
    });
    if (!result) return;
    const { existing } = result;

    ctx.log('COMPLETED', 'Message purged', { id: existing.id });

    // Audit — SAFE METADATA ONLY (never the body). Fire-and-forget.
    recordAudit({
      action: 'message.purge',
      actorId: actorId({ userId }),
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'message',
      targetId: existing.id,
      details: { isAnnouncement: existing.messageType === 'announcement' },
    });

    return sendSuccess(res, 200, {}, 'Message permanently deleted.');
  }));

  return router;
}
