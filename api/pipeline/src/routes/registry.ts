import { sendSuccess, sendBadRequest, ErrorCode, hashAccountInArn, hashId, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { db, schema } from '@mwashburn160/pipeline-core';
import { Router } from 'express';
import { z } from 'zod';

const PipelineRegistrySchema = z.object({
  pipelineId: z.string().min(1, 'pipelineId is required'),
  pipelineArn: z.string().min(1, 'pipelineArn is required'),
  pipelineName: z.string().min(1, 'pipelineName is required'),
  accountId: z.string().optional(),
  region: z.string().optional(),
  project: z.string().optional(),
  organization: z.string().optional(),
  stackName: z.string().optional(),
});

/**
 * Register pipeline registry routes.
 * POST /pipelines/registry — upsert a pipeline ARN mapping for event reporting.
 */
export function createRegistryRoutes(): Router {
  const router = Router();

  router.post('/registry', withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, PipelineRegistrySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { pipelineId, pipelineArn, pipelineName, accountId, region, project, organization, stackName } = validation.value;

    // Ensure account is hashed before storing (defense in depth)
    const safeArn = hashAccountInArn(pipelineArn);
    const safeAccountId = accountId ? hashId(accountId) : undefined;

    ctx.log('INFO', 'Registering pipeline for event reporting', { pipelineArn: safeArn });

    // Upsert by pipeline_arn (unique constraint)
    const [result] = await db
      .insert(schema.pipelineRegistry)
      .values({
        pipelineId,
        orgId,
        pipelineArn: safeArn,
        pipelineName,
        accountId: safeAccountId,
        region,
        project,
        organization,
        stackName,
        lastDeployed: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.pipelineRegistry.pipelineArn,
        set: {
          pipelineId,
          orgId,
          pipelineName,
          accountId: safeAccountId,
          region,
          project,
          organization,
          stackName,
          lastDeployed: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();

    ctx.log('COMPLETED', 'Pipeline registered', { id: result.id, arn: safeArn });

    sendSuccess(res, 200, { registry: result });
  }));

  return router;
}
