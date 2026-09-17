// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, isSystemAdmin, requireVisibilityWriteAccess, resolveVisibility, sendBadRequest, sendError, sendSuccess, userHasPermission, validateBody, PluginUpdateSchema, pickDefined, sendEntityNotFound } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { checkUpdateCompliance, needsComplianceRecheck } from '../helpers/update-compliance.js';
import { emitPluginAudit } from '../services/audit.js';
import { pluginService } from '../services/plugin-service.js';

/**
 * Register the UPDATE route on a router.
 *
 * Expects auth + orgId + tenant scope (the shared `/plugins` chain) and
 * `requirePermission('plugins:write')` from the parent mount in index.ts.
 */
export function createUpdatePluginRoutes(): Router {
  const router: Router = Router();

  router.put('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod
    const validation = validateBody(req, PluginUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    ctx.log('INFO', 'Plugin update request received', { id });

    const existing = await pluginService.findById(id, orgId);

    if (!existing) return sendEntityNotFound(res, 'Plugin');

    // Visibility ladder: `public` needs plugins:publish, `private` is author-only.
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'plugins:publish')) return;

    // Build update data from validated body
    const updateData: Record<string, unknown> = {
      // `name` and `version` are intentionally NOT updatable here — the pushed
      // registry image is keyed `<namespace>/<name>:<version>`, so renaming /
      // re-versioning the DB row desyncs it from the image and pipelines then
      // pull a nonexistent tag. bulk-plugin.ts excludes them for the same reason.
      ...pickDefined({
        description: body.description,
        keywords: body.keywords,
        category: body.category,
        metadata: body.metadata,
        pluginType: body.pluginType,
        computeType: body.computeType,
        primaryOutputDirectory: body.primaryOutputDirectory,
        env: body.env,
        installCommands: body.installCommands,
        commands: body.commands,
        isActive: body.isActive,
        isDefault: body.isDefault,
        buildArgs: body.buildArgs,
        timeout: body.timeout,
        failureBehavior: body.failureBehavior,
        secrets: body.secrets,
        // Developer-portal catalog metadata (lifecycle / classification).
        lifecycle: body.lifecycle,
        criticality: body.criticality,
        labels: body.labels,
        links: body.links,
      }),
      // Ownership reassignment is admin-only (see update-pipeline.ts).
      ...((req.user?.isAdmin === true || req.user?.isSuperAdmin === true)
        ? pickDefined({ ownerId: body.ownerId, ownerType: body.ownerType })
        : {}),
      // `public` needs plugins:publish — resolveVisibility clamps it to `org` otherwise.
      ...(body.visibility !== undefined ? { visibility: resolveVisibility(req, body.visibility, 'plugins:publish') } : {}),
    };

    // -- Compliance re-check on UPDATE (fail-closed) ------------------------
    // A plugin is executable code, so an edit to its build/run config or
    // visibility must not be allowed to turn a compliant plugin non-compliant
    // (upload already gates this). Only execution-relevant edits are re-checked.
    if (needsComplianceRecheck(updateData)) {
      const verdict = await checkUpdateCompliance(orgId, existing, updateData);
      if (verdict.outcome === 'blocked') {
        ctx.log('WARN', 'Plugin update blocked by compliance', { id, violations: verdict.violations.length });
        return sendError(res, 403, 'Plugin update blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
          violations: verdict.violations,
        });
      }
      if (verdict.outcome === 'unavailable') {
        ctx.log('ERROR', 'Compliance service unavailable — plugin update rejected', { error: verdict.error });
        return sendError(res, 503, 'Compliance service unavailable — plugin update rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
      }
    }

    // Promoting to default demotes the current default in the same transaction,
    // which needs write access to THAT row too — pass the caller's authority.
    const updated = await pluginService.update(
      id,
      updateData,
      orgId,
      userId || 'system',
      { isSystemAdmin: isSystemAdmin(req), canPublish: userHasPermission(req, 'plugins:publish') },
    );

    if (!updated) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Updated plugin', { id: updated.id, name: updated.name });

    // Audit the mutation — parity with delete/upload/deploy/restore (and the
    // peer services' update routes, which all audit).
    emitPluginAudit({
      action: 'plugin.update',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      targetType: 'plugin',
      targetId: id,
      details: {
        pluginName: updated.name,
        version: updated.version,
        visibility: updated.visibility,
      },
    });

    return sendSuccess(res, 200, { plugin: shapePlugin(updated) });
  }));

  return router;
}
