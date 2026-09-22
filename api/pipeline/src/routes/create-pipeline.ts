// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AppError, extractDbError, ErrorCode, isSystemAdmin, userHasPermission, createLogger, resolveVisibility, errorMessage, reserveQuota, decrementQuota, getServiceAuthHeader, requirePermission, sendBadRequest, sendError, sendInternalError, sendQuotaReserveDenied, sendSuccess, validateBody, PipelineCreateSchema, createComplianceClient, audited, actorId } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@pipeline-builder/api-server';
import { replaceNonAlphanumeric } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { validatePipelineTemplates } from '../helpers/pipeline-template-validator.js';
import { findPluginContractViolations, formatContractViolations } from '../helpers/plugin-contract-check.js';
import { emitPipelineAudit } from '../services/audit.js';
import { pipelineService, type PipelineInsert } from '../services/pipeline-service.js';

const logger = createLogger('create-pipeline');

const complianceClient = createComplianceClient();

/**
 * Register the CREATE route on a router.
 *
 * Uses the "atomic reserve + rollback on failure" pattern for the
 * `pipelines` quota: the slot is reserved at the start of the handler so
 * two concurrent requests at the limit can't both create pipelines. The
 * slot is given back via `decrementQuota` if the action fails after the
 * reservation lands. Read-only middleware (`createAuthenticatedWithOrgRoute`)
 * replaces `createProtectedRoute` so the `checkQuota` pre-flight doesn't
 * race the increment.
 */
export function createCreatePipelineRoutes( quotaService: QuotaService,
): Router {
  const router: Router = Router();

  router.post( '/',
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    // `inserted === false` promotes an existing default instead of inserting.
    audited('pipeline.create', 'pipeline.update'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      // Validate request body with Zod
      const validation = validateBody(req, PipelineCreateSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      }

      const body = validation.value;

      // Template validation (batches all errors in the body)
      try {
        validatePipelineTemplates(body);
      } catch (err) {
        return sendBadRequest(res, (err as Error).message, ErrorCode.TEMPLATE_VALIDATION_FAILED);
      }

      // Plugin contracts (W0.2): every plugin step's required metadata/vars
      // present with the declared types — refused here, not at synth.
      const contractViolations = await findPluginContractViolations(body.props, orgId, req.user?.parentOrganizationId);
      if (contractViolations.length > 0) {
        return sendError(res, 400, formatContractViolations(contractViolations), ErrorCode.TEMPLATE_CONTRACT_VIOLATION, { steps: contractViolations });
      }

      // Unspecified visibility defaults to `org`, NOT `private`: a pipeline is a
      // team asset that deploys shared infrastructure, so creating one must not
      // hide it from the team. A personal draft stays available, but opt-in.
      const visibility = resolveVisibility(req, body.visibility, 'pipelines:publish', 'org');

      // Normalize project and organization names and validate them BEFORE
      // reserving quota. Reserving first and then returning on an empty/invalid
      // name (as this used to) burned a `pipelines` slot per bad request — the
      // early return skipped the `decrementQuota` rollback. Mirror
      // bulk-pipeline.ts, which validates before it reserves.
      const project = replaceNonAlphanumeric(body.project, '_').toLowerCase();
      const organization = replaceNonAlphanumeric(body.organization, '_').toLowerCase();

      if (!project.replace(/_/g, '') || !organization.replace(/_/g, '')) {
        return sendBadRequest(res, 'Project and organization must contain alphanumeric characters', ErrorCode.VALIDATION_ERROR);
      }

      // Default pipelineName if not provided
      const pipelineName = body.pipelineName ?? `${organization}-${project}-pipeline`;

      // Mint a service token for the downstream S2S calls (quota, compliance)
      // rather than forwarding the end-user bearer. The caller's token may carry
      // only end-user scopes that service-to-service authorization rejects,
      // which would fail legitimate creates. Mirrors upload-plugin.ts.
      const serviceAuth = getServiceAuthHeader({ serviceName: 'pipeline', orgId, role: 'member' });

      // Reserve the quota slot atomically before any work runs. The quota
      // service does an atomic UPSERT/UPDATE (Postgres `INSERT ... ON CONFLICT
      // DO UPDATE` with a `WHERE used < limit` guard), so two concurrent
      // requests at the limit can't both pass. If the downstream action fails
      // (compliance block, DB save error), the slot is given back via
      // `decrementQuota` in the catch block.
      const reservation = await reserveQuota(quotaService, orgId, 'pipelines', serviceAuth);
      if (reservation.exceeded) {
        ctx.log('WARN', reservation.unavailable ? 'Pipeline quota unconfirmable (quota service unavailable)' : 'Pipeline quota exceeded', { orgId, used: reservation.quota.used, limit: reservation.quota.limit });
        // 503 + Retry-After when the quota service couldn't confirm; 429 when over limit.
        return sendQuotaReserveDenied(res, 'pipelines', reservation);
      }

      try {
        ctx.log('INFO', 'Pipeline creation request received', { project, organization });

        // -- Compliance check (fail-closed) -----------------------------------
        try {
          const complianceResult = await complianceClient.validatePipeline(orgId, {
            project,
            organization,
            pipelineName,
            props: body.props,
            visibility,
          }, serviceAuth, undefined, pipelineName, 'create');

          if (complianceResult.blocked) {
            ctx.log('WARN', 'Pipeline creation blocked by compliance', {
              project, violations: complianceResult.violations.length,
            });
            // Roll back the quota slot we reserved above — the pipeline was
            // never created so the org shouldn't be charged for it.
            decrementQuota(quotaService, orgId, 'pipelines', serviceAuth, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
            return sendError(res, 403, 'Pipeline creation blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
              violations: complianceResult.violations,
            });
          }
        } catch (err) {
          ctx.log('ERROR', 'Compliance service unavailable', {
            error: errorMessage(err),
          });
          decrementQuota(quotaService, orgId, 'pipelines', serviceAuth, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          return sendError(res, 503, 'Compliance service unavailable — pipeline creation rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
        }

        const { pipeline: result, inserted } = await pipelineService.createAsDefaultReportInserted( {
          orgId,
          project,
          organization,
          pipelineName,
          description: body.description ?? '',
          keywords: body.keywords ?? [],
          props: body.props as unknown as PipelineInsert['props'],
          visibility: visibility,
          createdBy: userId || 'system',
          // Catalog ownership + classification. Owner is ALWAYS the creator on
          // create — a client-supplied `ownerId` is ignored so a member can't
          // create an entity "owned" by someone else (poisoning their My Services
          // / scorecard). Ownership reassignment happens via update (admin-gated).
          ownerId: userId ?? 'system',
          ownerType: 'user',
          ...(body.lifecycle !== undefined ? { lifecycle: body.lifecycle } : {}),
          ...(body.criticality !== undefined ? { criticality: body.criticality } : {}),
          ...(body.labels !== undefined ? { labels: body.labels } : {}),
          ...(body.links !== undefined ? { links: body.links } : {}),
        },
        userId || 'system',
        project,
        organization,
        // A same-slot pipeline is updated in place only if the caller could
        // PUT it (visibility ladder); a tombstone must go through restore.
        { isSystemAdmin: isSystemAdmin(req), canPublish: userHasPermission(req, 'pipelines:publish') },
        );

        // Quota was reserved at the top of the handler. If the upsert UPDATED an
        // existing default for this org/project rather than inserting a net-new
        // pipeline, no create actually happened — give the reserved slot back so
        // repeated creates for the same org/project don't over-count the
        // per-period `pipelines` create quota. On save failure, the catch block
        // below rolls the reservation back.
        if (!inserted) {
          decrementQuota(quotaService, orgId, 'pipelines', serviceAuth, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
        }

        ctx.log('COMPLETED', 'Pipeline created', { id: result.id });

        // Best-effort attributed audit — emitted only after the write landed.
        // `inserted === false` means an existing default was UPDATED (quota slot
        // refunded above), so attribute it as an update, matching bulk-create.
        emitPipelineAudit({
          action: inserted ? 'pipeline.create' : 'pipeline.update',
          actorId: actorId({ userId }),
          orgId,
          targetType: 'pipeline',
          targetId: result.id,
          details: {
            project: result.project,
            organization: result.organization,
            pipelineName: result.pipelineName,
            visibility: result.visibility,
          },
        });

        const message = visibility === 'public'
          ? 'Public pipeline created successfully (accessible to all organizations)'
          : `Private pipeline created successfully (accessible to ${orgId} only)`;

        return sendSuccess(res, 201, {
          pipeline: {
            id: result.id,
            project: result.project,
            organization: result.organization,
            pipelineName: result.pipelineName,
            visibility: result.visibility,
            isDefault: result.isDefault,
            isActive: result.isActive,
            createdAt: result.createdAt,
            createdBy: result.createdBy,
          },
        }, message);
      } catch (error) {
        // Roll back the quota slot — the action failed so the org shouldn't
        // be charged for it.
        decrementQuota(quotaService, orgId, 'pipelines', serviceAuth, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
        // A typed refusal from the service (403 not-writable / 409 tombstone or
        // another author's private pipeline) is a client outcome, not a save
        // failure — let withRoute map it to its own status.
        if (error instanceof AppError) throw error;

        const message = errorMessage(error);
        const dbDetails = extractDbError(error);
        logger.error('Pipeline save failed', { requestId: ctx.requestId, error: message, orgId, ...dbDetails });
        return sendInternalError(res, 'Failed to save pipeline configuration', { details: message, ...dbDetails });
      }
    }),
  );

  return router;
}
