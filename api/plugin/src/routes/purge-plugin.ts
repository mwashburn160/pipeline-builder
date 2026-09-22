// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, loadAndPurge, sendSuccess, actorId, type QuotaService, recordAudit } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { refundPluginSlot } from '../helpers/quota-refund.js';
import { pluginService } from '../services/plugin-service.js';

/**
 * Register the PURGE route — manual, on-demand PERMANENT hard-delete of an
 * already soft-deleted plugin tombstone. This finalizes immediately what the
 * retention sweep (`purgeExpired`) would otherwise do at the tombstone's
 * `purge_after` deadline; the sweep still exists for tombstones no one purges
 * by hand.
 *
 * Expects auth + orgId, `requirePermission('plugins:write')` and `requireStepUp`
 * from the parent mount (index.ts) — the SAME authority as restore, sharing its
 * single step-up layer: purge is an irreversible destructive act, so it requires
 * a password re-verify on top of the frontend's explicit confirm dialog.
 *
 * The load-tombstone → visibility-gate → hard-delete → 404 skeleton is shared via
 * `loadAndPurge`: an unknown id or a row that is NOT currently soft-deleted 404s
 * (a live row can only be soft-deleted first), and a PUBLIC tombstone needs
 * `plugins:publish`. Dependent teardown rides the shared `onBeforePurge` hook
 * inside `purgeById`'s transaction — the machinery the retention sweep reuses.
 *
 * A tombstone that still carries its quota snapshot (one soft-deleted by a path
 * that didn't refund, e.g. bulk delete) has its `plugins` slot refunded here,
 * period-conditionally. A single delete already refunded and cleared it.
 */
export function createPurgePluginRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  router.post('/:id/purge', audited('plugin.purge'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const result = await loadAndPurge(req, res, pluginService, { orgId, userId, label: 'Plugin', publishPermission: 'plugins:publish' });
    if (!result) return;
    const { existing } = result;
    const refunded = refundPluginSlot(quotaService, existing, ctx.log.bind(null, 'WARN'));

    ctx.log('COMPLETED', 'Purged plugin', { id: existing.id, name: existing.name, refunded });

    recordAudit({
      action: 'plugin.purge',
      actorId: actorId({ userId }),
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'plugin',
      targetId: existing.id,
      details: {
        pluginName: existing.name,
        version: existing.version,
        visibility: existing.visibility,
      },
    });

    return sendSuccess(res, 200, {}, 'Plugin permanently deleted.');
  }));

  return router;
}
