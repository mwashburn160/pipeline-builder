// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, requirePublicAccess, resolveAccessModifier, sendBadRequest, sendError, sendSuccess, validateBody, PluginUpdateSchema, pickDefined, sendEntityNotFound, createComplianceClient, getServiceAuthHeader, errorMessage } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { pluginService } from '../services/plugin-service.js';

const complianceClient = createComplianceClient();

// Execution/config fields whose change can alter a plugin's compliance posture.
// A change to any of these on UPDATE triggers a fail-closed re-validation; a
// catalog-metadata-only edit (description/labels/lifecycle) does not.
const COMPLIANCE_RELEVANT_FIELDS = [
  'pluginType', 'computeType', 'timeout', 'failureBehavior', 'env', 'buildArgs',
  'installCommands', 'commands', 'accessModifier', 'secrets',
] as const;

/**
 * Register the UPDATE route on a router.
 *
 * Expects `requireAuth` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
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

    // Only system admins can edit non-private plugins
    if (!requirePublicAccess(req, res, existing, 'plugins:publish')) return;

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
      // Access modifier requires special handling (admin-only public)
      ...(body.accessModifier !== undefined ? { accessModifier: resolveAccessModifier(req, body.accessModifier, 'plugins:publish') } : {}),
    };

    // -- Compliance re-check on UPDATE (fail-closed) ------------------------
    // A plugin is executable code, so an edit to its build/run config or
    // visibility must not be allowed to turn a compliant plugin non-compliant
    // (upload already gates this). Re-validate only when an execution-relevant
    // field changed — a catalog-metadata-only edit keeps the same posture and
    // shouldn't pay a round-trip or be blocked by a compliance outage.
    if (COMPLIANCE_RELEVANT_FIELDS.some((f) => f in updateData)) {
      const serviceAuth = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });
      const val = <T>(k: string, fallback: T): T => (k in updateData ? updateData[k] as T : fallback);
      try {
        const complianceResult = await complianceClient.validatePlugin(orgId, {
          // name/version are immutable on update — keyed to the pushed image.
          name: existing.name,
          version: existing.version,
          pluginType: val('pluginType', existing.pluginType),
          computeType: val('computeType', existing.computeType),
          timeout: val('timeout', existing.timeout),
          failureBehavior: val('failureBehavior', existing.failureBehavior),
          env: val('env', existing.env),
          buildArgs: val('buildArgs', existing.buildArgs),
          installCommands: val('installCommands', existing.installCommands),
          commands: val('commands', existing.commands),
          accessModifier: val('accessModifier', existing.accessModifier),
          secrets: val('secrets', existing.secrets),
          metadata: val('metadata', existing.metadata),
          keywords: val('keywords', existing.keywords),
        }, serviceAuth, existing.id, existing.name, 'update');

        if (complianceResult.blocked) {
          ctx.log('WARN', 'Plugin update blocked by compliance', { id, violations: complianceResult.violations.length });
          return sendError(res, 403, 'Plugin update blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
            violations: complianceResult.violations,
          });
        }
      } catch (err) {
        ctx.log('ERROR', 'Compliance service unavailable — plugin update rejected', { error: errorMessage(err) });
        return sendError(res, 503, 'Compliance service unavailable — plugin update rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
      }
    }

    const updated = await pluginService.update(
      id,
      updateData,
      orgId,
      userId || 'system',
    );

    if (!updated) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Updated plugin', { id: updated.id, name: updated.name });

    return sendSuccess(res, 200, { plugin: shapePlugin(updated) });
  }));

  return router;
}
