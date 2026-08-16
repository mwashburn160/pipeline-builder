// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requirePermission,
  sendSuccess,
  sendBadRequest,
  sendError,
  ErrorCode,
  errorMessage,
  getParam,
  validateBody,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute, checkQuota, incrementQuotaFromCtx, incCounter } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { emitPipelineAudit } from '../services/audit.js';
import { executionIdempotency } from '../services/execution-idempotency.js';
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
 * Each route owns its auth + orgId + `pipelines:write` guard chain so the parent
 * can mount this router plainly on the shared '/pipelines' prefix without the
 * write permission leaking onto sibling reads.
 *
 * The trigger route is additionally metered on the org's `apiCalls` quota (there
 * is no dedicated `executions` quota in the `QuotaType` union) and protected by a
 * short per-(org,pipeline) idempotency window so a double-submit can't launch two
 * CodePipeline runs.
 */
export function createExecutionRoutes(quotaService: QuotaService): Router {
  const router = Router();

  // Auth + orgId, then require the write permission. Shared by both POST routes.
  const writeGuards = [...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write')];

  router.post(
    '/:pipelineId/executions',
    ...writeGuards,
    // Meter the trigger like the other quota'd routes: 429 when the org is over
    // its apiCalls budget BEFORE any AWS call. Increment happens on success below.
    checkQuota(quotaService, 'apiCalls'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const pipelineId = getParam(req.params, 'pipelineId');
      if (!pipelineId) return sendBadRequest(res, 'Pipeline id is required.', ErrorCode.MISSING_REQUIRED_FIELD);

      // Short idempotency window: refuse a duplicate trigger for the same
      // (org, pipeline) within the window rather than starting a second run.
      // Fails open when Redis is unavailable (single-replica / outage).
      if (!(await executionIdempotency.claim(orgId, pipelineId))) {
        ctx.log('WARN', 'Duplicate pipeline execution trigger suppressed', { pipelineId });
        return sendError(res, 409, 'A pipeline execution was just triggered; please wait a moment before retrying', ErrorCode.CONFLICT);
      }

      try {
        const { executionId } = await pipelineExecutionService.triggerExecution(pipelineId, orgId);
        ctx.log('COMPLETED', 'Triggered pipeline execution', { pipelineId, executionId });

        // Domain metric — CodePipeline execution started. Tagged by outcome only;
        // pipelineId/orgId are deliberately omitted to keep label cardinality bounded.
        incCounter('pipeline_executions_total', { outcome: 'started' });

        // Meter the successful trigger against the org's apiCalls budget.
        incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');

        // Best-effort attributed audit — the AWS CodePipeline start succeeded.
        emitPipelineAudit({
          action: 'pipeline.execution.start',
          actorId: req.user?.sub ?? userId ?? 'system',
          orgId,
          targetType: 'pipeline',
          targetId: pipelineId,
          details: { executionId },
        });

        return sendSuccess(res, 202, { executionId });
      } catch (err) {
        incCounter('pipeline_executions_total', { outcome: 'failed' });
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

  router.post('/:pipelineId/executions/:executionId/stop', ...writeGuards, withRoute(async ({ req, res, ctx, orgId, userId }) => {
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

      // Domain metric — CodePipeline execution stopped/cancelled.
      incCounter('pipeline_executions_total', { outcome: 'stopped' });

      // Best-effort attributed audit — the AWS CodePipeline stop succeeded.
      emitPipelineAudit({
        action: 'pipeline.execution.cancel',
        actorId: req.user?.sub ?? userId ?? 'system',
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
