// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  ErrorCode,
  errorMessage,
  getParam,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { emitPipelineAudit } from '../services/audit.js';
import {
  pipelineExecutionService,
  PipelineExecutionError,
  PE_PIPELINE_NOT_REGISTERED,
  PE_AWS_PIPELINE_NOT_FOUND,
  PE_NOT_STOPPABLE,
  PE_AWS_ERROR,
} from '../services/pipeline-execution-service.js';

const StopExecutionSchema = z.object({
  reason: z.string().max(200).optional(),
  abandon: z.boolean().optional(),
});

/** Pull the sanitized AWS name/message off a PipelineExecutionError, if present. */
function awsDetail(err: unknown): Record<string, unknown> | undefined {
  if (err instanceof PipelineExecutionError && (err.awsName || err.awsMessage)) {
    return { awsName: err.awsName, awsMessage: err.awsMessage };
  }
  return undefined;
}

/**
 * Register pipeline execution write routes — the AWS CodePipeline trigger /
 * cancel path. Both resolve pipelineId → the registered CodePipeline physical
 * name + region (org-scoped) and call CodePipeline directly.
 *
 * - POST /:pipelineId/executions               — start a new execution (202).
 * - POST /:pipelineId/executions/:executionId/stop — stop an in-flight execution.
 *
 * Gated by `pipelines:write` at the mount point in index.ts.
 */
export function createExecutionRoutes(): Router {
  const router = Router();

  router.post('/:pipelineId/executions', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const pipelineId = getParam(req.params, 'pipelineId');
    if (!pipelineId) return sendBadRequest(res, 'Pipeline id is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    try {
      const { executionId } = await pipelineExecutionService.triggerExecution(pipelineId, orgId);
      ctx.log('COMPLETED', 'Triggered pipeline execution', { pipelineId, executionId });

      // Best-effort attributed audit — the AWS CodePipeline start succeeded.
      emitPipelineAudit({
        action: 'pipeline.execution.start',
        actorId: userId || 'system',
        orgId,
        targetType: 'pipeline',
        targetId: pipelineId,
        details: { executionId },
      });

      return sendSuccess(res, 202, { executionId });
    } catch (err) {
      const code = errorMessage(err);
      if (code === PE_PIPELINE_NOT_REGISTERED) {
        return sendError(res, 404, 'Pipeline is not deployed/registered', ErrorCode.NOT_FOUND);
      }
      if (code === PE_AWS_PIPELINE_NOT_FOUND) {
        ctx.log('ERROR', 'CodePipeline not found for registered pipeline (stale registry)', { pipelineId, ...awsDetail(err) });
        return sendError(res, 404, 'Pipeline not found in AWS', ErrorCode.NOT_FOUND);
      }
      if (code === PE_AWS_ERROR) {
        ctx.log('ERROR', 'Upstream AWS error triggering pipeline', { pipelineId, ...awsDetail(err) });
        return sendError(res, 502, 'Upstream AWS error', ErrorCode.INTERNAL_ERROR, awsDetail(err));
      }
      ctx.log('ERROR', 'Failed to trigger pipeline execution', { pipelineId });
      return sendError(res, 500, 'Failed to trigger pipeline execution', ErrorCode.INTERNAL_ERROR);
    }
  }));

  router.post('/:pipelineId/executions/:executionId/stop', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const pipelineId = getParam(req.params, 'pipelineId');
    const executionId = getParam(req.params, 'executionId');
    if (!pipelineId) return sendBadRequest(res, 'Pipeline id is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    if (!executionId) return sendBadRequest(res, 'Execution id is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, StopExecutionSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    try {
      await pipelineExecutionService.stopExecution(pipelineId, orgId, executionId, {
        reason: validation.value.reason,
        abandon: validation.value.abandon,
      });
      ctx.log('COMPLETED', 'Stopped pipeline execution', { pipelineId, executionId });

      // Best-effort attributed audit — the AWS CodePipeline stop succeeded.
      emitPipelineAudit({
        action: 'pipeline.execution.cancel',
        actorId: userId || 'system',
        orgId,
        targetType: 'pipeline',
        targetId: pipelineId,
        details: {
          executionId,
          abandon: validation.value.abandon ?? false,
        },
      });

      return sendSuccess(res, 200, { stopped: true });
    } catch (err) {
      const code = errorMessage(err);
      if (code === PE_PIPELINE_NOT_REGISTERED) {
        return sendError(res, 404, 'Pipeline is not deployed/registered', ErrorCode.NOT_FOUND);
      }
      if (code === PE_AWS_PIPELINE_NOT_FOUND) {
        ctx.log('ERROR', 'CodePipeline not found for registered pipeline (stale registry)', { pipelineId, executionId, ...awsDetail(err) });
        return sendError(res, 404, 'Pipeline not found in AWS', ErrorCode.NOT_FOUND);
      }
      if (code === PE_NOT_STOPPABLE) {
        return sendError(res, 409, 'Execution is not in a stoppable state', ErrorCode.CONFLICT);
      }
      if (code === PE_AWS_ERROR) {
        ctx.log('ERROR', 'Upstream AWS error stopping pipeline execution', { pipelineId, executionId, ...awsDetail(err) });
        return sendError(res, 502, 'Upstream AWS error', ErrorCode.INTERNAL_ERROR, awsDetail(err));
      }
      ctx.log('ERROR', 'Failed to stop pipeline execution', { pipelineId, executionId });
      return sendError(res, 500, 'Failed to stop pipeline execution', ErrorCode.INTERNAL_ERROR);
    }
  }));

  return router;
}
