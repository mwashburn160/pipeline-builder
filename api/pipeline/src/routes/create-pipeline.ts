/**
 * @module routes/create-pipeline
 * @description Pipeline creation.
 *
 * POST /pipelines — create a new pipeline configuration
 *
 * Automatically sets any existing default pipeline for the same
 * project/organization to non-default before inserting the new one.
 */

import { extractDbError, ErrorCode, createLogger, isSystemAdmin, errorMessage, sendBadRequest, sendInternalError, validateBody, PipelineCreateSchema } from '@mwashburn160/api-core';
import { createRequestContext, createProtectedRoute, SSEManager, QuotaService } from '@mwashburn160/api-server';
import { AccessModifier, replaceNonAlphanumeric } from '@mwashburn160/pipeline-core';
import { Router, Request, Response } from 'express';
import { pipelineService, type PipelineInsert } from '../services/pipeline-service';

const logger = createLogger('create-pipeline');

/**
 * Register the CREATE route on a router.
 *
 * This route uses `checkQuota('pipelines')` instead of `'apiCalls'`,
 * so it applies its own middleware chain rather than sharing with read routes.
 */
export function createCreatePipelineRoutes(
  sseManager: SSEManager,
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  router.post(
    '/',
    ...createProtectedRoute(sseManager, quotaService, 'pipelines'),
    async (req: Request, res: Response) => {
      const ctx = createRequestContext(req, res, sseManager);

      // Validate request body with Zod
      const validation = validateBody(req, PipelineCreateSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      }

      const body = validation.value;

      try {
        let accessModifier = body.accessModifier === 'public' ? 'public' : 'private';

        // Only system admins can create public pipelines
        if (!isSystemAdmin(req) && accessModifier === 'public') {
          accessModifier = 'private';
          ctx.log('INFO', 'Non-system-admin forced to private access');
        }

        // Normalize project and organization names
        const project = replaceNonAlphanumeric(body.project, '_').toLowerCase();
        const organization = replaceNonAlphanumeric(body.organization, '_').toLowerCase();

        // Default pipelineName if not provided
        const pipelineName = body.pipelineName ?? `${organization}-${project}-pipeline`;

        const orgId = ctx.identity.orgId!.toLowerCase();
        ctx.log('INFO', 'Pipeline creation request received', { project, organization, orgId });

        const result = await pipelineService.createAsDefault(
          {
            orgId,
            project,
            organization,
            pipelineName,
            description: body.description ?? '',
            keywords: body.keywords ?? [],
            props: body.props as unknown as PipelineInsert['props'],
            accessModifier: accessModifier as AccessModifier,
            createdBy: ctx.identity.userId || 'system',
          },
          ctx.identity.userId || 'system',
          project,
          organization,
        );

        void quotaService.increment(orgId, 'pipelines', req.headers.authorization || '');

        ctx.log('COMPLETED', 'Pipeline created', { id: result.id });

        return res.status(201).json({
          success: true,
          statusCode: 201,
          id: result.id,
          project: result.project,
          organization: result.organization,
          pipelineName: result.pipelineName,
          accessModifier: result.accessModifier,
          isDefault: result.isDefault,
          isActive: result.isActive,
          createdAt: result.createdAt,
          createdBy: result.createdBy,
          message:
            accessModifier === 'public'
              ? 'Public pipeline created successfully (accessible to all organizations)'
              : `Private pipeline created successfully (accessible to ${orgId} only)`,
        });
      } catch (error) {
        const message = errorMessage(error);
        const dbDetails = extractDbError(error);
        logger.error('Pipeline save failed', { error: message, ...dbDetails });

        return sendInternalError(res, 'Failed to save pipeline configuration', { details: message, ...dbDetails });
      }
    },
  );

  return router;
}
