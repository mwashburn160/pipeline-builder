// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  sendPaginatedNested,
  ErrorCode,
  errorMessage,
  getParam,
  hashAccountInArn,
  hashId,
  parsePaginationParams,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import {
  pipelineRegistryService,
  PR_PIPELINE_NOT_OWNED,
  PR_ARN_OWNED_BY_OTHER_ORG,
} from '../services/pipeline-registry-service';

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
 * - POST /pipelines/registry — upsert a pipeline ARN mapping for event reporting.
 * - GET  /pipelines/registry — list registry entries owned by the caller's org.
 *   Used by the dashboard's "deployed pipelines" panel and by drift-detection
 *   tools (the `pipeline-manager audit-stacks` CLI joins this against live
 *   CloudFormation stacks tagged `pipeline-builder` to surface orphans).
 */
export function createRegistryRoutes(): Router {
  const router = Router();

  router.get('/registry', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query as Record<string, unknown>);
    const { rows, total } = await pipelineRegistryService.list(orgId, limit, offset);
    ctx.log('COMPLETED', 'Listed pipeline registry', { count: rows.length });
    return sendPaginatedNested(res, 'registry', rows, {
      total, limit, offset, hasMore: offset + rows.length < total,
    });
  }));

  router.post('/registry', withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, PipelineRegistrySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const v = validation.value;
    // Ensure account is hashed before storing (defense in depth)
    const safeArn = hashAccountInArn(v.pipelineArn);
    const safeAccountId = v.accountId ? hashId(v.accountId) : undefined;

    ctx.log('INFO', 'Registering pipeline for event reporting', { pipelineArn: safeArn });

    try {
      const result = await pipelineRegistryService.upsert({
        pipelineId: v.pipelineId,
        orgId,
        pipelineArn: safeArn,
        pipelineName: v.pipelineName,
        accountId: safeAccountId,
        region: v.region,
        project: v.project,
        organization: v.organization,
        stackName: v.stackName,
      });
      ctx.log('COMPLETED', 'Pipeline registered', { id: result.id, arn: safeArn });
      sendSuccess(res, 200, { registry: result });
    } catch (err) {
      const code = errorMessage(err);
      if (code === PR_PIPELINE_NOT_OWNED) {
        return sendError(res, 404, 'Pipeline not found in your organization', ErrorCode.NOT_FOUND);
      }
      if (code === PR_ARN_OWNED_BY_OTHER_ORG) {
        ctx.log('WARN', 'Rejected registry claim for ARN owned by another org', { pipelineArn: safeArn });
        return sendError(res, 409, 'Pipeline ARN is registered to a different organization', ErrorCode.CONFLICT);
      }
      throw err;
    }
  }));

  /**
   * DELETE /pipelines/registry/:id — remove a single registry row by its UUID.
   *
   * Used to reconcile drift after a CloudFormation stack is deleted out-of-band
   * (i.e. without `pipeline-manager deploy`), which leaves a stale registry row.
   * The `pipeline-manager audit-stacks` CLI surfaces such rows; this endpoint is
   * the supported path to clear them.
   *
   * Tenancy: scoped to the caller's orgId. A 404 is returned for both
   * "row does not exist" and "row exists but belongs to another org" so a
   * caller cannot probe other orgs' registry contents.
   *
   * Note: this is a hard delete, not a soft delete. The registry table is a
   * pure mapping cache — losing a row never loses information that isn't
   * already in CloudFormation, so there's nothing to recover.
   */
  router.delete('/registry/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Registry id is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const deleted = await pipelineRegistryService.delete(id, orgId);
    if (!deleted) return sendError(res, 404, 'Registry entry not found.', ErrorCode.NOT_FOUND);

    ctx.log('COMPLETED', 'Pipeline registry row deleted', { id: deleted.id, arn: deleted.pipelineArn });
    sendSuccess(res, 200, { id: deleted.id });
  }));

  return router;
}
