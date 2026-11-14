// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, isManagedToolchainPlugin, loadAndRestore, sendSuccess, actorId, recordAudit, type QuotaService } from '@pipeline-builder/api-core';
import { withQuotaReservation, withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { toolchainUseConsoleError } from '../helpers/managed-toolchain.js';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { pluginService } from '../services/plugin-service.js';

/**
 * Register the RESTORE route — undo a soft-delete within the retention window
 * (before the purge sweep hard-deletes the tombstone).
 *
 * Expects auth + orgId, `requirePermission('plugins:write')` and `requireStepUp`
 * from the parent mount (index.ts), whose single step-up layer it shares with
 * purge (delete's authority plus a step-up re-verify, since restore reverses a
 * destructive act).
 * The load → publish-gate → restore → 404 skeleton is shared via `loadAndRestore`.
 *
 * A restore CHARGES a `plugins` slot in the current period, like the upload it
 * reverses the deletion of: delete refunds the version's slot (helpers/
 * quota-refund.ts), so a restore that charged nothing would let an org at its
 * cap delete, upload, restore — and repeat — past its limit. Denied at the cap
 * (429, or 503 when the quota can't be confirmed); the restored row records the
 * period it was charged to, so a later delete refunds it.
 */
export function createRestorePluginRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  router.post('/:id/restore', audited('plugin.restore'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // A managed toolchain half is never restored on its own: deleting a release
    // removes its `toolchain_release` row and tombstones BOTH halves together, so
    // restoring one would resurrect a half with no release (or half a release).
    // Release lifecycle lives in the Toolchain console — for the system org too.
    const tombstone = typeof req.params.id === 'string' && req.params.id.length > 0
      ? await pluginService.findDeletedById(req.params.id, orgId)
      : null;
    if (tombstone && isManagedToolchainPlugin(tombstone.name)) throw toolchainUseConsoleError(tombstone.name);

    const outcome = await withQuotaReservation(
      { quotaService, orgId, type: 'plugins', serviceName: 'plugin', logWarn: ctx.log.bind(null, 'WARN'), res },
      async (slot) => {
        const restoredResult = await loadAndRestore(req, res, pluginService, { orgId, userId, label: 'Plugin', publishPermission: 'plugins:publish' });
        if (!restoredResult) {
          slot.refund();
          return null;
        }
        await pluginService.setQuotaSnapshot(restoredResult.restored.id, slot.reservation.quota.resetAt ?? null);
        return restoredResult;
      },
    );
    if (outcome.status !== 'done' || !outcome.value) return;
    const { existing, restored } = outcome.value;

    ctx.log('COMPLETED', 'Restored plugin', { id: restored.id, name: restored.name });

    recordAudit({
      action: 'plugin.restore',
      actorId: actorId({ userId }),
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'plugin',
      targetId: restored.id,
      details: {
        pluginName: restored.name,
        version: restored.version,
        visibility: restored.visibility,
      },
    });

    return sendSuccess(res, 200, { plugin: shapePlugin(restored) }, 'Plugin restored.');
  }));

  return router;
}
