// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Version lifecycle that DOES something (plugin-ecosystem W0.4):
 *
 * - `POST /plugins/:id/deprecate` — mark a version deprecated (or clear it with
 *   `{ deprecated: false }`). It keeps resolving, but `/plugins/lookup` and
 *   `/plugins/find` answer with a `warnings` entry, synth prints it, and AI
 *   plugin selection stops offering it.
 * - `POST /plugins/:id/yank` — stop a version resolving for NEW synths: ranges,
 *   `latest` and the default skip it; an exact pin still finds it, with a
 *   warning carrying the reason. Yanking the default promotes the next one. A
 *   version published to the ecosystem is yanked by the system org on request
 *   (409 here).
 *
 * Expects auth + orgId + tenant scope and `plugins:write` from the parent mount.
 */

import {
  ErrorCode, actorId, audited, getParam, requireVisibilityWriteAccess, sendBadRequest, sendEntityNotFound, sendSuccess, validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';

import { onPluginDeprecated } from '../helpers/deprecation-notice.js';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { emitPluginAudit } from '../services/audit.js';
import { pluginService } from '../services/plugin-service.js';

const DeprecateBodySchema = z.object({
  deprecated: z.boolean().optional(),
  message: z.string().trim().max(500).optional(),
}).strict();

const YankBodySchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(500),
}).strict();

export function createVersionLifecycleRoutes(): Router {
  const router: Router = Router();

  router.post('/:id/deprecate', audited('plugin.version.deprecate'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    const body = validateBody(req, DeprecateBodySchema);
    if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
    const deprecated = body.value.deprecated ?? true;

    const existing = await pluginService.findById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Plugin');
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'plugins:publish')) return;

    const wasDeprecated = existing.deprecatedAt !== null && existing.deprecatedAt !== undefined;
    const updated = await pluginService.setDeprecated(existing, orgId, userId || 'system', {
      deprecated,
      message: deprecated ? body.value.message ?? null : null,
    });
    if (!updated) return sendEntityNotFound(res, 'Plugin');

    if (deprecated && !wasDeprecated) void onPluginDeprecated(updated, actorId({ userId }));
    ctx.log('COMPLETED', deprecated ? 'Plugin version deprecated' : 'Plugin version un-deprecated', { id, name: updated.name });

    emitPluginAudit({
      action: 'plugin.version.deprecate',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'plugin',
      targetId: id,
      details: { pluginName: updated.name, version: updated.version, deprecated },
    });

    return sendSuccess(res, 200, { plugin: shapePlugin(updated) });
  }));

  router.post('/:id/yank', audited('plugin.version.yank'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    const body = validateBody(req, YankBodySchema);
    if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);

    const existing = await pluginService.findById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Plugin');
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'plugins:publish')) return;

    // Throws 409 PLUGIN_VERSION_FROZEN for a version published to the ecosystem.
    const { yanked, promoted } = await pluginService.yankVersion(existing, orgId, userId || 'system', body.value.reason);
    if (!yanked) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Plugin version yanked', { id, name: yanked.name, promotedId: promoted?.id });

    emitPluginAudit({
      action: 'plugin.version.yank',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'plugin',
      targetId: id,
      details: {
        pluginName: yanked.name,
        version: yanked.version,
        ...(promoted ? { promotedDefaultVersion: promoted.version } : {}),
      },
    });

    return sendSuccess(res, 200, {
      plugin: shapePlugin(yanked),
      ...(promoted ? { promotedDefault: { id: promoted.id, version: promoted.version } } : {}),
    });
  }));

  return router;
}
