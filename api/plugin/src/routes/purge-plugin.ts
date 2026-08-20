// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, getParam, requirePublicAccess, sendBadRequest, sendEntityNotFound, sendSuccess } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { emitPluginAudit } from '../services/audit.js';
import { pluginService } from '../services/plugin-service.js';

/**
 * Register the PURGE route — manual, on-demand PERMANENT hard-delete of an
 * already soft-deleted plugin tombstone. This finalizes immediately what the
 * retention sweep (`purgeExpired`) would otherwise do at the tombstone's
 * `purge_after` deadline; the sweep still exists for tombstones no one purges
 * by hand.
 *
 * Expects `requireAuth`, `requireOrgId`, `requirePermission('plugins:write')`
 * and `requireStepUp` as router-level middleware in the parent — the SAME
 * authority as restore, including a step-up password re-verify: purge is an
 * irreversible destructive act, so it requires step-up on top of the frontend's
 * explicit confirm dialog. A PUBLIC (shared) plugin additionally requires
 * `plugins:publish`, mirroring delete/restore.
 *
 * 404 when the id is unknown or NOT currently soft-deleted (a live row can only
 * be soft-deleted first, never hard-deleted directly). Dependent teardown rides
 * the shared `onBeforePurge` hook inside the purge transaction — the same
 * machinery the retention sweep reuses for a single id via `purgeById`.
 */
export function createPurgePluginRoutes(): Router {
  const router: Router = Router();

  router.post('/:id/purge', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    ctx.log('INFO', 'Plugin purge request received', { id });

    // Load the TOMBSTONE (own-org). A live row / unknown id / already-purged →
    // 404, so purge can only ever finalize an already-soft-deleted row.
    const existing = await pluginService.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Plugin');

    // Public (shared) plugins: same publish gate as delete/restore.
    if (!requirePublicAccess(req, res, existing, 'plugins:publish')) return;

    // Reuse the retention sweep's hard-delete machinery for a single id, pinned
    // to the caller's org. Null → the tombstone vanished between load and purge.
    const purged = await pluginService.purgeById(id, orgId);
    if (!purged) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Purged plugin', { id, name: existing.name });

    emitPluginAudit({
      action: 'plugin.purge',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'plugin',
      targetId: existing.id,
      details: {
        pluginName: existing.name,
        version: existing.version,
        accessModifier: existing.accessModifier,
      },
    });

    return sendSuccess(res, 200, {}, 'Plugin permanently deleted.');
  }));

  return router;
}
