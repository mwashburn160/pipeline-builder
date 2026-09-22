// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, getParam, ErrorCode, requireStepUp, requireVisibilityWriteAccess, sendBadRequest, sendSuccess, sendEntityNotFound, actorId, type QuotaService, recordAudit } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { refundPluginSlot } from '../helpers/quota-refund.js';
import { pluginService } from '../services/plugin-service.js';

/** `?force=true` — delete a version that is in use or listed. */
function isForce(req: Request): boolean {
  return String(req.query.force ?? '').toLowerCase() === 'true';
}

/**
 * A forced delete needs a step-up (password / factor re-verify). Applied ONLY
 * when `force=true`: an ordinary delete stays a one-click action. The route
 * answers the request itself, so the mount's later `requireStepUp` layer (for
 * purge / restore) never sees this request — its `jti` is consumed exactly once.
 */
function stepUpWhenForced(req: Request, res: Response, next: NextFunction): void {
  if (!isForce(req)) return next();
  void requireStepUp(req, res, next);
}

/**
 * Register the DELETE route on a router.
 *
 * Expects auth + orgId + tenant scope (the shared `/plugins` chain) and
 * `requirePermission('plugins:write')` from the parent mount in app-routes.ts.
 *
 * Delete safety:
 * - a version referenced by a pending publish request is never deletable (409);
 * - one used by the org's pipelines, or published to a listing, is refused with
 *   409 `PLUGIN_VERSION_IN_USE` unless `?force=true`, which requires a step-up;
 * - deleting the default promotes the next default automatically;
 * - the version's `plugins` quota slot is refunded (period-conditional).
 */
export function createDeletePluginRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  router.delete('/:id', audited('plugin.delete'), stepUpWhenForced, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const force = isForce(req);
    ctx.log('INFO', 'Plugin delete request received', { id, force });

    const existing = await pluginService.findById(id, orgId);

    if (!existing) return sendEntityNotFound(res, 'Plugin');

    // Visibility ladder: `public` needs plugins:publish, `private` is author-only.
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'plugins:publish')) return;

    // Throws a typed 409 (frozen / in use / listed) the error middleware maps.
    // The delete is pinned to the caller's org, so a public/system-org sample the
    // read surfaced matches zero rows → null: no 200, no audit, no refund.
    const { deleted, inUse, listed, promoted } = await pluginService.deleteVersion(existing, orgId, userId || 'system', { force });
    if (!deleted) return sendEntityNotFound(res, 'Plugin');

    const refunded = refundPluginSlot(quotaService, existing, ctx.log.bind(null, 'WARN'));

    ctx.log('COMPLETED', 'Deleted plugin', { id, name: existing.name, inUse, listed, promotedId: promoted?.id, refunded });

    recordAudit({
      action: 'plugin.delete',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'plugin',
      targetId: id,
      details: {
        pluginName: existing.name,
        version: existing.version,
        visibility: existing.visibility,
        ...(force ? { force: true, inUsePipelines: inUse, listed } : {}),
        ...(promoted ? { promotedDefaultVersion: promoted.version } : {}),
      },
    });

    return sendSuccess(res, 200, {
      ...(promoted ? { promotedDefault: { id: promoted.id, version: promoted.version } } : {}),
    }, 'Plugin deleted.');
  }));

  return router;
}
