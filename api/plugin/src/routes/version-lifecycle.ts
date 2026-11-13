// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Version lifecycle that DOES something:
 *
 * - `POST /plugins/:id/deprecate` — mark a version deprecated (or clear it with
 *   `{ deprecated: false }`). It keeps resolving, but `/plugins/lookup` and
 *   `/plugins/find` answer with a `warnings` entry, synth prints it, and AI
 *   plugin selection stops offering it.
 * - `POST /plugins/:id/yank` — stop a version resolving for NEW synths: ranges,
 *   `latest` and the default skip it; an exact pin still finds it, with a
 *   warning carrying the reason. Yanking the default promotes the next one. A
 *   version published to the ecosystem is yanked by the system org on request
 *   (409 here). A yank never refuses for being in use (no image is deleted):
 *   the response carries an in-use `warnings` entry and the orgs on the version
 *   are notified (services/version-withdrawal.ts).
 *
 * Expects auth + orgId + tenant scope and `plugins:write` from the parent mount.
 */

import {
  ErrorCode, actorId, audited, getParam, requireVisibilityWriteAccess, sendBadRequest, sendEntityNotFound, sendSuccess, validateBody,
  recordAudit, SYSTEM_ACTOR_ID,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';

import { onPluginDeprecated } from '../helpers/deprecation-notice.js';
import { assertNotManaged } from '../helpers/managed-toolchain.js';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { pluginService } from '../services/plugin-service.js';
import { onVersionWithdrawn } from '../services/version-withdrawal.js';

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
    // Managed toolchain releases are deprecated in the Toolchain console (both halves at once).
    assertNotManaged(existing.name);
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'plugins:publish')) return;

    const wasDeprecated = existing.deprecatedAt !== null && existing.deprecatedAt !== undefined;
    const updated = await pluginService.setDeprecated(existing, orgId, userId || SYSTEM_ACTOR_ID, {
      deprecated,
      message: deprecated ? body.value.message ?? null : null,
    });
    if (!updated) return sendEntityNotFound(res, 'Plugin');

    if (deprecated && !wasDeprecated) void onPluginDeprecated(updated, actorId({ userId }));
    ctx.log('COMPLETED', deprecated ? 'Plugin version deprecated' : 'Plugin version un-deprecated', { id, name: updated.name });

    recordAudit({
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
    // Managed toolchain releases are yanked in the Toolchain console, which
    // restores the previous platform default; never promoteNextDefault.
    assertNotManaged(existing.name);
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'plugins:publish')) return;

    // Throws 409 PLUGIN_VERSION_FROZEN for a version published to the ecosystem.
    const { yanked, promoted } = await pluginService.yankVersion(existing, orgId, userId || SYSTEM_ACTOR_ID, body.value.reason);
    if (!yanked) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Plugin version yanked', { id, name: yanked.name, promotedId: promoted?.id });
    const inUse = await onVersionWithdrawn(yanked, 'yanked', { reason: body.value.reason });

    recordAudit({
      action: 'plugin.version.yank',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'plugin',
      targetId: id,
      details: {
        pluginName: yanked.name,
        version: yanked.version,
        // Why, and which image: a yank is reviewed by its reason, and the
        // digest is what pinned pipelines keep pulling.
        reason: body.value.reason,
        digest: yanked.imageDigest ?? null,
        ...(promoted ? { promotedDefaultVersion: promoted.version } : {}),
        inUsePipelines: inUse?.pipelineCount ?? 0,
        inUseOrgs: inUse?.orgCount ?? 0,
      },
    });

    return sendSuccess(res, 200, {
      plugin: shapePlugin(yanked),
      ...(promoted ? { promotedDefault: { id: promoted.id, version: promoted.version } } : {}),
      ...(inUse ? { warnings: [inUse] } : {}),
    });
  }));

  return router;
}
