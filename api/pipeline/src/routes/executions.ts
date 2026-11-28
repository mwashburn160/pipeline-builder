// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requirePermission,
  sendSuccess,
  sendBadRequest,
  sendError,
  ErrorCode,
  getParam,
  validateBody,
  audited,
  actorId,
  recordAudit,
} from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute, incCounter } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { DUPLICATE_TRIGGER_MESSAGE, queuedRunRequestDto, triggerExecutionInWindow } from '../helpers/trigger-execution.js';
import { routeExecution } from '../runners/execution-routing.js';
import { asRunnerRouteError } from '../runners/routing.js';

/**
 * The stop body. `reason` / `abandon` are accepted for the dashboard's form,
 * but the runner protocol carries neither: the runner stops the execution.
 */
const StopExecutionSchema = z.object({
  reason: z.string().max(200).optional(),
  abandon: z.boolean().optional(),
});

/**
 * The start body: `runnerId` runs it with that runner when no runner is linked
 * to the pipeline (the dashboard's "Run with" choice). Empty: the linked
 * runner, else discovery across every eligible runner.
 */
const StartBodySchema = z.object({
  runnerId: z.string().uuid('runnerId must be a pipeline runner id').optional(),
});

/**
 * Register pipeline execution write routes. Runners are the only execution
 * path: both routes queue a signed request for the pipeline's runner (linked,
 * or found by discovery) and answer 202 with the queued run request; the
 * dashboard polls `GET /:pipelineId/run-requests/:requestId`.
 *
 * - POST /:pipelineId/executions               — queue a start (202).
 * - POST /:pipelineId/executions/:executionId/stop — queue a stop (202).
 *
 * Each route owns its auth + orgId + `pipelines:write` guard chain so the parent
 * can mount this router plainly on the shared '/pipelines' prefix without the
 * write permission leaking onto sibling reads.
 *
 * The start route's apiCalls meter + check come from the '/pipelines' prefix
 * mount in app-routes.ts. It is also protected by a short per-(org, pipeline)
 * idempotency window, so a double click queues one run.
 */
export function createExecutionRoutes(): Router {
  const router = Router();

  // Auth + orgId, then require the write permission. Shared by both POST routes.
  const writeGuards = [...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write')];

  router.post(
    '/:pipelineId/executions',
    ...writeGuards,
    audited('pipeline.execution.start'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const pipelineId = getParam(req.params, 'pipelineId');
      if (!pipelineId) return sendBadRequest(res, 'Pipeline id is required.', ErrorCode.MISSING_REQUIRED_FIELD);

      // Optional `{ runnerId }`: run with that runner when none is linked to the pipeline.
      const body = StartBodySchema.safeParse(req.body ?? {});
      if (!body.success) return sendBadRequest(res, body.error.issues[0]?.message ?? 'Invalid body', ErrorCode.VALIDATION_ERROR);
      const runnerId = body.data.runnerId?.toLowerCase();

      try {
        const parentOrgId = req.user?.parentOrganizationId;
        const started = await triggerExecutionInWindow(pipelineId, orgId, { requestedBy: userId, ...(parentOrgId ? { parentOrgId } : {}), ...(runnerId ? { runnerId } : {}) });
        if (started.status === 'duplicate') {
          ctx.log('WARN', 'Duplicate pipeline execution trigger suppressed', { pipelineId });
          recordAudit({
            action: 'pipeline.execution.start',
            actorId: actorId({ userId }),
            orgId,
            targetType: 'pipeline_execution',
            outcome: 'failure',
            details: { pipelineId, reason: 'duplicate_suppressed' },
          });
          return sendError(res, 409, DUPLICATE_TRIGGER_MESSAGE, ErrorCode.CONFLICT);
        }
        const { run } = started;
        // Recorded + queued; the dispatcher audits the terminal outcome. Never
        // the runner's URL or an account id. A start already pending for this
        // pipeline is returned, not queued again — audited as `reused` so the
        // trail shows one run, asked for twice.
        ctx.log('COMPLETED', run.reused ? 'Reused a pending runner start' : 'Queued pipeline execution for a runner', { pipelineId, requestId: run.requestId, runnerId: run.runnerId });
        incCounter('pipeline_executions_total', { outcome: 'queued' });
        recordAudit({
          action: 'pipeline.execution.start',
          actorId: actorId({ userId }),
          orgId,
          targetType: 'pipeline_execution',
          details: run.reused
            ? { pipelineId, reusedRequestId: run.requestId, runnerId: run.runnerId, outcome: 'reused' }
            : { pipelineId, requestId: run.requestId, runnerId: run.runnerId, attempts: 0, outcome: 'queued' },
        });
        return sendSuccess(res, 202, queuedRunRequestDto(run));
      } catch (err) {
        incCounter('pipeline_executions_total', { outcome: 'failed' });
        const refusal = asRunnerRouteError(err);
        // A failed start is audited too. No execution id exists, so there is no targetId.
        recordAudit({
          action: 'pipeline.execution.start',
          actorId: actorId({ userId }),
          orgId,
          targetType: 'pipeline_execution',
          outcome: 'failure',
          details: { pipelineId, reason: refusal ? refusal.code.toLowerCase() : 'error', ...(refusal ? { outcome: 'refused' } : {}) },
        });
        if (refusal) return sendError(res, refusal.status, refusal.message, refusal.code, refusal.details);
        ctx.log('ERROR', 'Failed to queue pipeline execution', { pipelineId });
        return sendError(res, 500, 'Failed to trigger pipeline execution', ErrorCode.INTERNAL_ERROR);
      }
    }));

  router.post('/:pipelineId/executions/:executionId/stop', ...writeGuards, audited('pipeline.execution.cancel'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const pipelineId = getParam(req.params, 'pipelineId');
    const executionId = getParam(req.params, 'executionId');
    if (!pipelineId) return sendBadRequest(res, 'Pipeline id is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    if (!executionId) return sendBadRequest(res, 'Execution id is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, StopExecutionSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    try {
      const parentOrgId = req.user?.parentOrganizationId;
      const run = await routeExecution({ pipelineId, orgId, action: 'stop', executionId, requestedBy: userId, ...(parentOrgId ? { parentOrgId } : {}) });
      ctx.log('COMPLETED', 'Queued pipeline execution stop for a runner', { pipelineId, executionId, requestId: run.requestId, runnerId: run.runnerId });
      incCounter('pipeline_executions_total', { outcome: 'stop_queued' });
      recordAudit({
        action: 'pipeline.execution.cancel',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline_execution',
        targetId: executionId,
        details: { pipelineId, requestId: run.requestId, runnerId: run.runnerId, attempts: 0, outcome: 'queued' },
      });
      return sendSuccess(res, 202, queuedRunRequestDto(run));
    } catch (err) {
      // Counted like a failed start: a stop the user asked for that was not
      // queued is otherwise invisible on the dashboard.
      incCounter('pipeline_executions_total', { outcome: 'stop_failed' });
      const refusal = asRunnerRouteError(err);
      recordAudit({
        action: 'pipeline.execution.cancel',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline_execution',
        targetId: executionId,
        outcome: 'failure',
        details: { pipelineId, reason: refusal ? refusal.code.toLowerCase() : 'error', ...(refusal ? { outcome: 'refused' } : {}) },
      });
      if (refusal) return sendError(res, refusal.status, refusal.message, refusal.code, refusal.details);
      ctx.log('ERROR', 'Failed to queue pipeline execution stop', { pipelineId, executionId });
      return sendError(res, 500, 'Failed to stop pipeline execution', ErrorCode.INTERNAL_ERROR);
    }
  }));

  return router;
}
