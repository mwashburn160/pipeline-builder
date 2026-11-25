// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getParam, ErrorCode, requireVisibilityWriteAccess, sendBadRequest, sendError, sendSuccess, sendEntityNotFound, validateBody, PipelineUpdateSchema, normalizeArrayFields, audited, actorId, proposable, recordAudit, withProposalProvenance, requirePermission } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { checkPipelineUpdateCompliance, isComplianceRelevantUpdate } from '../helpers/pipeline-update-compliance.js';
import { alignPipelineUpdateIdentity, auditedChanges, buildPipelineUpdateData, complianceBlockedDetails, pluginWarningsField, validatePipelineWrite } from '../helpers/pipeline-write.js';
import { recordPipelineResolution } from '../helpers/plugin-contract-check.js';
import { electionRefusal } from '../helpers/remediation-settings.js';
import { pipelineService } from '../services/pipeline-service.js';

/**
 * The update body plus the optimistic-concurrency token: `expectedUpdatedAt` is
 * the `updatedAt` the editor loaded. Present → the write lands only if the
 * pipeline is unchanged since (else 412 PRECONDITION_FAILED); absent → last
 * write wins. Never a column write (buildPipelineUpdateData picks columns).
 */
const PipelineUpdateRequestSchema = PipelineUpdateSchema.extend({
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});

/**
 * Register the UPDATE route on a router.
 *
 * Expects `requireAuth` and `requireOrgId` to have already been
 * applied as router-level middleware in the parent.
 */
export function createUpdatePipelineRoutes(): Router {
  const router: Router = Router();

  router.put('/:id', requirePermission('pipelines:write'), audited('pipeline.update', 'pipeline.remediation-upgrades.update'), proposable, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Validate request body with Zod
    const validation = validateBody(req, PipelineUpdateRequestSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    const check = await validatePipelineWrite(body, orgId, req.user?.parentOrganizationId, id);
    if (check.rejection) return sendError(res, check.rejection.status, check.rejection.message, check.rejection.code, check.rejection.details);

    ctx.log('INFO', 'Pipeline update request received', { id });

    const existing = await pipelineService.findById(id, orgId);

    if (!existing) return sendEntityNotFound(res, 'Pipeline');

    // Visibility ladder: `pipelines:publish` for a public pipeline, authorship
    // for a private one, plain `pipelines:write` (already checked) for an org one.
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'pipelines:publish')) return;

    // isDefault is handled separately below via setDefault() for promotion.
    // The service stamps updatedAt/updatedBy.
    // The name and the props agree (the synth names the CodePipeline from
    // props). A rename alone rewrites the STORED props: guarded on the row read
    // here unless the caller sent its own token, so a concurrent props edit is a
    // 412, never silently overwritten.
    const aligned = alignPipelineUpdateIdentity(buildPipelineUpdateData(req, body), existing);
    const updateData: Record<string, unknown> = aligned.data;
    const expectedUpdatedAt = body.expectedUpdatedAt ?? (aligned.fromStored ? existing.updatedAt ?? undefined : undefined);

    // The plugin security fixes election (nightly CVE remediation). Opting out
    // is always allowed; `apply` only when the org default is apply or the
    // root org allows pipelines to choose it (403 otherwise).
    const electionBefore = existing.remediationUpgrades ?? 'inherit';
    if (body.remediationUpgrades !== undefined && body.remediationUpgrades !== electionBefore) {
      const refusal = await electionRefusal(body.remediationUpgrades, orgId, req.user?.parentOrganizationId);
      if (refusal) return sendError(res, 403, refusal, ErrorCode.PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED);
      updateData.remediationUpgrades = body.remediationUpgrades;
    }

    // -- Compliance re-check on UPDATE (fail-closed) ------------------------
    // Shared with bulk update (see pipeline-update-compliance.ts): only a
    // props / visibility change can alter the compliance posture.
    if (isComplianceRelevantUpdate(body)) {
      const verdict = await checkPipelineUpdateCompliance(orgId, existing, updateData);
      if (verdict.status === 'blocked') {
        ctx.log('WARN', 'Pipeline update blocked by compliance', { id, violations: verdict.violations.length });
        // The refused attempt is audited too — which rules blocked which change.
        recordAudit({
          action: 'pipeline.update',
          actorId: actorId({ userId }),
          orgId,
          targetType: 'pipeline',
          targetId: id,
          outcome: 'failure',
          details: withProposalProvenance(req.headers, {
            pipelineName: existing.pipelineName,
            fields: Object.keys(updateData),
            ...complianceBlockedDetails(verdict.violations),
          }),
        });
        return sendError(res, 403, 'Pipeline update blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
          violations: verdict.violations,
        });
      }
      if (verdict.status === 'unavailable') {
        ctx.log('ERROR', 'Compliance service unavailable — pipeline update rejected', { error: verdict.error });
        return sendError(res, 503, 'Compliance service unavailable — pipeline update rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
      }
    }

    // A stale token makes the service throw ConcurrencyConflictError → 412.
    let updated;
    if (body.isDefault === true) {
      // With a token, the conditional column write runs FIRST (even with no
      // other field, as a check-and-stamp): promoting must not land on a
      // pipeline that moved on, and setDefault itself bumps `updatedAt`.
      if (Object.keys(updateData).length > 0 || expectedUpdatedAt !== undefined) {
        updated = await pipelineService.update(id, updateData, orgId, userId, { expectedUpdatedAt });
        if (!updated) return sendEntityNotFound(res, 'Pipeline');
      }
      // Promote-to-default takes the FOR UPDATE-locked transactional path so
      // it can't race a concurrent setDefault on the same slot. Pass orgId (the
      // tenant UUID); the slot itself is read from the promoted row.
      updated = await pipelineService.setDefault(existing.orgId, id, userId);
    } else {
      // Allow explicit demotion (isDefault: false) as a normal column write.
      if (body.isDefault === false) updateData.isDefault = false;
      updated = await pipelineService.update(id, updateData, orgId, userId, { expectedUpdatedAt });
    }

    if (!updated) return sendEntityNotFound(res, 'Pipeline');

    ctx.log('COMPLETED', 'Updated pipeline', { id: updated.id, name: updated.pipelineName });

    // What the new config resolves to (the report's declared side, and the
    // reference set a plugin version's removal guard reads). AWAITED, so a plugin
    // delete right after this update sees the references it dropped; never throws.
    if (body.props !== undefined) await recordPipelineResolution(updated.id, orgId, req.user?.parentOrganizationId, updated.props);

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
        changes: auditedChanges(existing, updated),
      }),
    });

    if (updateData.remediationUpgrades !== undefined) {
      recordAudit({
        action: 'pipeline.remediation-upgrades.update',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline',
        targetId: updated.id,
        details: { pipelineName: updated.pipelineName, before: electionBefore, after: updated.remediationUpgrades },
      });
    }

    return sendSuccess(res, 200, { pipeline: normalizeArrayFields(updated, ['keywords']), ...pluginWarningsField(check.pluginWarnings) });
  }));

  return router;
}
