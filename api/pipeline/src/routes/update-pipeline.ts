// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, requireVisibilityWriteAccess, sendBadRequest, sendError, sendSuccess, sendEntityNotFound, validateBody, PipelineUpdateSchema, normalizeArrayFields, audited, actorId, proposable, recordAudit, withProposalProvenance } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { checkPipelineUpdateCompliance, isComplianceRelevantUpdate } from '../helpers/pipeline-update-compliance.js';
import { buildPipelineUpdateData, validatePipelineWrite } from '../helpers/pipeline-write.js';
import { pipelineService } from '../services/pipeline-service.js';

/**
 * Register the UPDATE route on a router.
 *
 * Expects `requireAuth` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createUpdatePipelineRoutes(): Router {
  const router: Router = Router();

  router.put('/:id', audited('pipeline.update'), proposable, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod
    const validation = validateBody(req, PipelineUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    const rejection = await validatePipelineWrite(body, orgId, req.user?.parentOrganizationId);
    if (rejection) return sendError(res, rejection.status, rejection.message, rejection.code, rejection.details);

    ctx.log('INFO', 'Pipeline update request received', { id });

    const existing = await pipelineService.findById(id, orgId);

    if (!existing) return sendEntityNotFound(res, 'Pipeline');

    // Visibility ladder: `pipelines:publish` for a public pipeline, authorship
    // for a private one, plain `pipelines:write` (already checked) for an org one.
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'pipelines:publish')) return;

    // isDefault is handled separately below via setDefault() for promotion.
    // The service stamps updatedAt/updatedBy.
    const updateData: Record<string, unknown> = buildPipelineUpdateData(req, body);

    // -- Compliance re-check on UPDATE (fail-closed) ------------------------
    // Shared with bulk update (see pipeline-update-compliance.ts): only a
    // props / visibility change can alter the compliance posture.
    if (isComplianceRelevantUpdate(body)) {
      const verdict = await checkPipelineUpdateCompliance(orgId, existing, updateData);
      if (verdict.status === 'blocked') {
        ctx.log('WARN', 'Pipeline update blocked by compliance', { id, violations: verdict.violations.length });
        return sendError(res, 403, 'Pipeline update blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
          violations: verdict.violations,
        });
      }
      if (verdict.status === 'unavailable') {
        ctx.log('ERROR', 'Compliance service unavailable — pipeline update rejected', { error: verdict.error });
        return sendError(res, 503, 'Compliance service unavailable — pipeline update rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
      }
    }

    let updated;
    if (body.isDefault === true) {
      // Promote-to-default takes the FOR UPDATE-locked transactional path so
      // it can't race a concurrent setDefault on the same project.
      // Pass orgId (the tenant UUID) — setDefault scopes clear-others by orgId.
      updated = await pipelineService.setDefault(existing.project, existing.orgId, id, userId);

      // Apply the rest of the update body (if any non-isDefault fields changed).
      if (Object.keys(updateData).length > 0) {
        updated = await pipelineService.update(id, updateData, orgId, userId);
      }
    } else {
      // Allow explicit demotion (isDefault: false) as a normal column write.
      if (body.isDefault === false) updateData.isDefault = false;
      updated = await pipelineService.update(id, updateData, orgId, userId);
    }

    if (!updated) return sendEntityNotFound(res, 'Pipeline');

    ctx.log('COMPLETED', 'Updated pipeline', { id: updated.id, name: updated.pipelineName });

    // Best-effort attributed audit — emitted only after the update landed.
    recordAudit({
      action: 'pipeline.update',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'pipeline',
      targetId: updated.id,
      // The handler's details stay authoritative; `proposedBy: 'ask-agent'` is
      // added only when the request carried the Ask panel's provenance header.
      details: withProposalProvenance(req.headers, {
        pipelineName: updated.pipelineName,
        fields: Object.keys(updateData),
        setDefault: body.isDefault === true,
      }),
    });

    return sendSuccess(res, 200, { pipeline: normalizeArrayFields(updated, ['keywords']) });
  }));

  return router;
}
