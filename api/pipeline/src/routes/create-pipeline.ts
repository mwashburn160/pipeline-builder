/**
 * @module routes/create-pipeline
 * @description Pipeline creation.
 *
 * POST /pipelines — create a new pipeline configuration
 *
 * Automatically sets any existing default pipeline for the same
 * project/organization to non-default before inserting the new one.
 */

import { extractDbError, ErrorCode, createLogger, isSystemAdmin } from '@mwashburn160/api-core';
import { createRequestContext, authenticateToken, SSEManager, QuotaService } from '@mwashburn160/api-server';
import { db, schema, BuilderProps, AccessModifier, replaceNonAlphanumeric } from '@mwashburn160/pipeline-core';
import { and, eq } from 'drizzle-orm';
import { Router, Request, Response, RequestHandler } from 'express';
import { errorMessage, sendBadRequest, sendInternalError } from '../helpers/pipeline-helpers';
import { checkQuota } from '../middleware/check-quota';
import { requireOrgId } from '../middleware/require-org-id';

const logger = createLogger('create-pipeline');

/** Request body for pipeline creation. */
interface PipelineRequestBody {
  readonly project?: string;
  readonly organization?: string;
  readonly pipelineName?: string;
  readonly accessModifier?: AccessModifier;
  readonly props: BuilderProps;
}

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
    authenticateToken as RequestHandler,
    requireOrgId(sseManager) as RequestHandler,
    checkQuota(quotaService, sseManager, 'pipelines') as RequestHandler,
    async (req: Request, res: Response) => {
      const ctx = createRequestContext(req, res, sseManager);
      const body = req.body as PipelineRequestBody;

      try {
        let accessModifier = body.accessModifier === 'public' ? 'public' : 'private';

        // Only system admins can create public pipelines
        if (!isSystemAdmin(req) && accessModifier === 'public') {
          accessModifier = 'private';
          ctx.log('INFO', 'Non-system-admin forced to private access');
        }

        if (!body.props || typeof body.props !== 'object') {
          return sendBadRequest(res, 'props object is required', ErrorCode.MISSING_REQUIRED_FIELD);
        }

        // Resolve project & organization: prefer top-level fields,
        // fall back to values inside props for backward compatibility.
        const rawProps = body.props as unknown as Record<string, unknown>;
        const resolvedProject: string | undefined = body.project ?? rawProps.project as string | undefined;
        const resolvedOrganization: string | undefined = body.organization ?? rawProps.organization as string | undefined;

        if (!resolvedProject || !resolvedOrganization) {
          return sendBadRequest(res, 'project and organization are required', ErrorCode.MISSING_REQUIRED_FIELD);
        }

        // Extract the actual BuilderProps to store.
        // If props contains a nested "props" key with a "synth" object, the caller
        // sent a full pipeline payload as the props — unwrap one level.
        const builderProps: BuilderProps =
          rawProps.props && typeof rawProps.props === 'object' && (rawProps.props as Record<string, unknown>).synth
            ? rawProps.props as BuilderProps
            : body.props as BuilderProps;

        const project = replaceNonAlphanumeric(resolvedProject, '_').toLowerCase();
        const organization = replaceNonAlphanumeric(resolvedOrganization, '_').toLowerCase();

        // Resolve pipelineName using same strategy as pipeline-builder.ts:
        //   props.pipelineName ?? `${organization}-${project}-pipeline`
        const builderPropsRecord = builderProps as unknown as Record<string, unknown>;
        const pipelineName: string =
          body.pipelineName
          ?? builderPropsRecord.pipelineName as string
          ?? `${organization}-${project}-pipeline`;

        const orgId = ctx.identity.orgId!.toLowerCase();
        ctx.log('INFO', 'Pipeline creation request received', { project, organization, orgId });

        const result = await db.transaction(async (tx) => {
          await tx
            .update(schema.pipeline)
            .set({
              isDefault: false,
              updatedAt: new Date(),
              updatedBy: ctx.identity.userId || 'system',
            })
            .where(
              and(
                eq(schema.pipeline.project, project),
                eq(schema.pipeline.organization, organization),
                eq(schema.pipeline.isDefault, true),
              ),
            );

          const [inserted] = await tx
            .insert(schema.pipeline)
            .values({
              orgId,
              project,
              organization,
              pipelineName,
              props: builderProps,
              accessModifier: accessModifier as AccessModifier,
              isDefault: true,
              isActive: true,
              createdBy: ctx.identity.userId || 'system',
            })
            .returning();

          return inserted;
        });

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
