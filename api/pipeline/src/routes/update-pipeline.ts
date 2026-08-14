// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, requirePublicAccess, resolveAccessModifier, sendBadRequest, sendError, sendSuccess, sendEntityNotFound, validateBody, PipelineUpdateSchema, pickDefined, normalizeArrayFields, createComplianceClient, getServiceAuthHeader, errorMessage } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { validatePipelineTemplates, type PipelineLike } from '../helpers/pipeline-template-validator.js';
import { emitPipelineAudit } from '../services/audit.js';
import { pipelineService } from '../services/pipeline-service.js';

const complianceClient = createComplianceClient();

/**
 * Register the UPDATE route on a router.
 *
 * Expects `requireAuth` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createUpdatePipelineRoutes(): Router {
  const router: Router = Router();

  router.put('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod
    const validation = validateBody(req, PipelineUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    // Validate any templates in the update body (metadata.*, vars.*, projectName)
    try {
      validatePipelineTemplates(body as unknown as PipelineLike);
    } catch (err) {
      return sendBadRequest(res, (err as Error).message, ErrorCode.TEMPLATE_VALIDATION_FAILED);
    }

    ctx.log('INFO', 'Pipeline update request received', { id });

    const existing = await pipelineService.findById(id, orgId);

    if (!existing) return sendEntityNotFound(res, 'Pipeline');

    // Only system admins can edit non-private pipelines
    if (!requirePublicAccess(req, res, existing, 'pipelines:publish')) return;

    // Build update data from validated body
    const updateData: Record<string, unknown> = {
      ...pickDefined({
        pipelineName: body.pipelineName,
        description: body.description,
        keywords: body.keywords,
        props: body.props, // Validated by PipelineUpdateSchema (BuilderPropsSchema)
        isActive: body.isActive,
        // Developer-portal catalog metadata (lifecycle / classification).
        lifecycle: body.lifecycle,
        criticality: body.criticality,
        labels: body.labels,
        links: body.links,
        // isDefault is handled separately below via setDefault() for promotion.
      }),
      // Ownership reassignment is admin-only — a regular member must not be able
      // to hand a resource to (or take it from) another user/team.
      ...((req.user?.isAdmin === true || req.user?.isSuperAdmin === true)
        ? pickDefined({ ownerId: body.ownerId, ownerType: body.ownerType })
        : {}),
      // Access modifier requires special handling (admin-only public)
      ...(body.accessModifier !== undefined ? { accessModifier: resolveAccessModifier(req, body.accessModifier, 'pipelines:publish') } : {}),
      updatedAt: new Date(),
      updatedBy: userId || 'system',
    };

    // -- Compliance re-check on UPDATE (fail-closed) ------------------------
    // An update that changes the pipeline's config or visibility must not be
    // allowed to turn a compliant pipeline non-compliant (create already gates
    // this; without it, edits were a detective-only hole). Only re-validate when
    // a compliance-relevant field changed (props / accessModifier) — a metadata-
    // or name-only edit doesn't alter the compliance posture, so we don't make
    // those pay a compliance round-trip or get blocked by a compliance outage.
    if (body.props !== undefined || body.accessModifier !== undefined) {
      const serviceAuth = getServiceAuthHeader({ serviceName: 'pipeline', orgId, role: 'member' });
      const resolvedName = (updateData.pipelineName ?? existing.pipelineName) as string | undefined;
      try {
        const complianceResult = await complianceClient.validatePipeline(orgId, {
          project: existing.project,
          organization: existing.organization,
          pipelineName: resolvedName,
          props: updateData.props ?? existing.props,
          accessModifier: updateData.accessModifier ?? existing.accessModifier,
        }, serviceAuth, existing.id, resolvedName, 'update');

        if (complianceResult.blocked) {
          ctx.log('WARN', 'Pipeline update blocked by compliance', { id, violations: complianceResult.violations.length });
          return sendError(res, 403, 'Pipeline update blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
            violations: complianceResult.violations,
          });
        }
      } catch (err) {
        ctx.log('ERROR', 'Compliance service unavailable — pipeline update rejected', { error: errorMessage(err) });
        return sendError(res, 503, 'Compliance service unavailable — pipeline update rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
      }
    }

    let updated;
    if (body.isDefault === true) {
      // Promote-to-default takes the FOR UPDATE-locked transactional path so
      // it can't race a concurrent setDefault on the same project.
      // Pass orgId (the tenant UUID) — setDefault scopes clear-others by orgId.
      updated = await pipelineService.setDefault(existing.project, existing.orgId, id, userId || 'system');

      // Apply the rest of the update body (if any non-isDefault fields changed).
      // updatedAt/updatedBy are always present, so >2 means real columns.
      if (Object.keys(updateData).length > 2) {
        updated = await pipelineService.update(id, updateData, orgId, userId || 'system');
      }
    } else {
      // Allow explicit demotion (isDefault: false) as a normal column write.
      if (body.isDefault === false) updateData.isDefault = false;
      updated = await pipelineService.update(id, updateData, orgId, userId || 'system');
    }

    if (!updated) return sendEntityNotFound(res, 'Pipeline');

    ctx.log('COMPLETED', 'Updated pipeline', { id: updated.id, name: updated.pipelineName });

    // Best-effort attributed audit — emitted only after the update landed.
    emitPipelineAudit({
      action: 'pipeline.update',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      targetType: 'pipeline',
      targetId: updated.id,
      details: {
        pipelineName: updated.pipelineName,
        fields: Object.keys(updateData),
        setDefault: body.isDefault === true,
      },
    });

    return sendSuccess(res, 200, { pipeline: normalizeArrayFields(updated, ['keywords']) });
  }));

  return router;
}
