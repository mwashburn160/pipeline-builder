import { sendSuccess, sendBadRequest, ErrorCode, hashAccountInArn, hashId } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { db, schema } from '@mwashburn160/pipeline-core';
import { Router } from 'express';


/**
 * Register pipeline registry routes.
 * POST /pipelines/registry — upsert a pipeline ARN mapping for event reporting.
 */
export function createRegistryRoutes(): Router {
  const router = Router();

  router.post('/registry', withRoute(async ({ req, res, ctx, orgId }) => {
    const { pipelineId, pipelineArn, pipelineName, accountId, region, project, organization, stackName } = req.body;

    if (!pipelineId || !pipelineArn || !pipelineName) {
      return sendBadRequest(res, 'pipelineId, pipelineArn, and pipelineName are required', ErrorCode.VALIDATION_ERROR);
    }

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
