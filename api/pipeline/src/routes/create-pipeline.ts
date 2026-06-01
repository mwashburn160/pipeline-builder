// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { extractDbError, ErrorCode, createLogger, resolveAccessModifier, errorMessage, reserveQuota, decrementQuota, sendBadRequest, sendError, sendInternalError, sendQuotaExceeded, sendSuccess, validateBody, PipelineCreateSchema, createComplianceClient } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@pipeline-builder/api-server';
import { AccessModifier, replaceNonAlphanumeric } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { validatePipelineTemplates, type PipelineLike } from '../helpers/pipeline-template-validator';
import { pipelineService, type PipelineInsert } from '../services/pipeline-service';

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
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      // Validate request body with Zod
      const validation = validateBody(req, PipelineCreateSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      }

      const body = validation.value;

      // Template validation (batches all errors in the body)
      try {
        validatePipelineTemplates(body as unknown as PipelineLike);
      } catch (err) {
        return sendBadRequest(res, (err as Error).message, ErrorCode.TEMPLATE_VALIDATION_FAILED);
      }

      // Reserve the quota slot atomically before any work runs. The quota
      // service does an atomic UPSERT/UPDATE (Postgres `INSERT ... ON CONFLICT
      // DO UPDATE` with a `WHERE used < limit` guard), so two concurrent
      // requests at the limit can't both pass. If the downstream action fails
      // (compliance block, DB save error), the slot is given back via
      // `decrementQuota` in the catch block.
      const authHeader = req.headers.authorization || '';
      const reservation = await reserveQuota(quotaService, orgId, 'pipelines', authHeader);
      if (reservation.exceeded) {
        ctx.log('WARN', 'Pipeline quota exceeded', { orgId, used: reservation.quota.used, limit: reservation.quota.limit });
        return sendQuotaExceeded(res, 'pipelines', reservation.quota, reservation.quota.resetAt);
      }

      try {
        const accessModifier = resolveAccessModifier(req, body.accessModifier);

        // Normalize project and organization names
        const project = replaceNonAlphanumeric(body.project, '_').toLowerCase();
        const organization = replaceNonAlphanumeric(body.organization, '_').toLowerCase();

        if (!project.replace(/_/g, '') || !organization.replace(/_/g, '')) {
          return sendBadRequest(res, 'Project and organization must contain alphanumeric characters', ErrorCode.VALIDATION_ERROR);
        }

        // Default pipelineName if not provided
        const pipelineName = body.pipelineName ?? `${organization}-${project}-pipeline`;

        ctx.log('INFO', 'Pipeline creation request received', { project, organization });

        // -- Compliance check (fail-closed) -----------------------------------
        try {
          const complianceResult = await complianceClient.validatePipeline(orgId, {
            project,
            organization,
            pipelineName,
            props: body.props,
            accessModifier,
          }, req.headers.authorization || '', undefined, pipelineName, 'create');

          if (complianceResult.blocked) {
            ctx.log('WARN', 'Pipeline creation blocked by compliance', {
              project, violations: complianceResult.violations.length,
            });
            // Roll back the quota slot we reserved above — the pipeline was
            // never created so the org shouldn't be charged for it.
            decrementQuota(quotaService, orgId, 'pipelines', authHeader, ctx.log.bind(null, 'WARN'));
            return sendError(res, 403, 'Pipeline creation blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
              violations: complianceResult.violations,
            });
          }
        } catch (err) {
          ctx.log('ERROR', 'Compliance service unavailable', {
            error: errorMessage(err),
          });
          decrementQuota(quotaService, orgId, 'pipelines', authHeader, ctx.log.bind(null, 'WARN'));
          return sendError(res, 503, 'Compliance service unavailable — pipeline creation rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
        }

        const result = await pipelineService.createAsDefault( {
          orgId,
          project,
          organization,
          pipelineName,
          description: body.description ?? '',
          keywords: body.keywords ?? [],
          props: body.props as unknown as PipelineInsert['props'],
          accessModifier: accessModifier as AccessModifier,
          createdBy: userId || 'system',
        },
        userId || 'system',
        project,
        organization,
        );

        // Quota was already reserved at the top of the handler; no post-hoc
        // increment needed. On unexpected save failure, the catch block
        // below rolls the reservation back.

        ctx.log('COMPLETED', 'Pipeline created', { id: result.id });

        const message = accessModifier === AccessModifier.PUBLIC
          ? 'Public pipeline created successfully (accessible to all organizations)'
          : `Private pipeline created successfully (accessible to ${orgId} only)`;

        return sendSuccess(res, 201, {
          pipeline: {
            id: result.id,
            project: result.project,
            organization: result.organization,
            pipelineName: result.pipelineName,
            accessModifier: result.accessModifier,
            isDefault: result.isDefault,
            isActive: result.isActive,
            createdAt: result.createdAt,
            createdBy: result.createdBy,
          },
        }, message);
      } catch (error) {
        const message = errorMessage(error);
        const dbDetails = extractDbError(error);
        logger.error('Pipeline save failed', { requestId: ctx.requestId, error: message, orgId, ...dbDetails });

        // Roll back the quota slot — the action failed so the org shouldn't
        // be charged for it.
        decrementQuota(quotaService, orgId, 'pipelines', authHeader, ctx.log.bind(null, 'WARN'));
        return sendInternalError(res, 'Failed to save pipeline configuration', { details: message, ...dbDetails });
      }
    }),
  );

  return router;
}
