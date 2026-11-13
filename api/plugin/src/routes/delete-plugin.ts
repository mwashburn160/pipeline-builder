// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AppError, SYSTEM_ACTOR_ID, audited, getParam, ErrorCode, requireStepUp, requireVisibilityWriteAccess, sendBadRequest, sendSuccess, sendEntityNotFound, actorId, type QuotaService, recordAudit } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { assertNotManaged } from '../helpers/managed-toolchain.js';
import { refundPluginSlot } from '../helpers/quota-refund.js';
import { pluginService } from '../services/plugin-service.js';
import { onVersionWithdrawn } from '../services/version-withdrawal.js';

/** `?force=true` — delete a version that is in use or listed. */
function isForce(req: Request): boolean {
  return String(req.query.force ?? '').toLowerCase() === 'true';
}

/**
 * Put a removal REFUSED because pipelines still reference the version (409
 * PLUGIN_VERSION_IN_USE) on the trail as a failed `plugin.delete` /
 * `plugin.purge`, naming the referencing pipelines — a refusal otherwise
 * leaves only an error response, and "who tried to pull a live image out from
 * under these pipelines" is exactly what a reviewer asks. Rethrows `err`
 * untouched for the error middleware.
 */
export function auditRemovalRefused(err: unknown, e: { action: 'plugin.delete' | 'plugin.purge'; orgId: string; userId?: string; pluginId: string; pluginName?: string; version?: string }): never {
  if (err instanceof AppError && err.code === ErrorCode.PLUGIN_VERSION_IN_USE) {
    const d = err.details ?? {};
    const pipelines = Array.isArray(d.pipelines) ? (d.pipelines as Array<{ id?: unknown }>).map((p) => p.id).filter((x) => typeof x === 'string') : [];
    recordAudit({
      action: e.action,
      actorId: actorId({ userId: e.userId }),
      orgId: e.orgId,
      targetType: 'plugin',
      targetId: e.pluginId,
      outcome: 'failure',
      details: {
        refusal: ErrorCode.PLUGIN_VERSION_IN_USE,
        reason: d.reason ?? null,
        ...(e.pluginName && { pluginName: e.pluginName }),
        ...(e.version && { version: e.version }),
        pipelineCount: d.pipelineCount ?? null,
        orgCount: d.orgCount ?? null,
        pipelineIds: pipelines,
        severity: d.severity ?? null,
      },
    });
  }
  throw err;
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
 * - one ANY pipeline references is refused with 409 `PLUGIN_VERSION_IN_USE`,
 *   with or without force (no override);
 * - one published to a listing is refused with 409 `PLUGIN_VERSION_IN_USE`
 *   unless `?force=true`, which requires a step-up; the orgs using it (the
 *   listing's installers included) are notified once it is gone;
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

    // A managed toolchain release is deleted only in the Toolchain console.
    assertNotManaged(existing.name);

    // Visibility ladder: `public` needs plugins:publish, `private` is author-only.
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'plugins:publish')) return;

    // Throws a typed 409 (frozen / in use / listed) the error middleware maps.
    // The delete is pinned to the caller's org, so a public/system-org sample the
    // read surfaced matches zero rows → null: no 200, no audit, no refund.
    const { deleted, inUse, listed, promoted } = await pluginService.deleteVersion(existing, orgId, userId || SYSTEM_ACTOR_ID, { force })
      .catch((err: unknown) => auditRemovalRefused(err, { action: 'plugin.delete', orgId, userId, pluginId: id, pluginName: existing.name, version: existing.version }));
    if (!deleted) return sendEntityNotFound(res, 'Plugin');

    const refunded = refundPluginSlot(quotaService, existing, ctx.log.bind(null, 'WARN'));

    ctx.log('COMPLETED', 'Deleted plugin', { id, name: existing.name, inUse, listed, promotedId: promoted?.id, refunded });
    void onVersionWithdrawn(existing, 'deleted');

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
