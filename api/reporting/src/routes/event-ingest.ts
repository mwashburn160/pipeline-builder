// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, ErrorCode, createLogger } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { CoreConstants, runWithTenantContext } from '@pipeline-builder/pipeline-core';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';

const logger = createLogger('event-ingest');

/** Zod schema for validating individual ingest events. */
const ingestEventSchema = z.object({
  pipelineArn: z.string().min(1),
  eventSource: z.enum(['codepipeline', 'codebuild', 'plugin-build']),
  eventType: z.enum(['PIPELINE', 'STAGE', 'ACTION', 'BUILD']),
  status: z.string().min(1),
  executionId: z.string().optional(),
  stageName: z.string().optional(),
  actionName: z.string().optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
  durationMs: z.number().int().min(0).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const ingestBatchSchema = z.object({
  events: z.array(ingestEventSchema).min(1, 'At least one event is required'),
});


export function createEventIngestRoutes(): Router {
  const router = Router();

  router.post('/events', withRoute(async ({ req, res, ctx }) => {
    const parsed = ingestBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }

    const { events } = parsed.data;
    if (events.length > CoreConstants.MAX_EVENTS_PER_BATCH) {
      return sendBadRequest(res, `Maximum ${CoreConstants.MAX_EVENTS_PER_BATCH} events per batch`, ErrorCode.VALIDATION_ERROR);
    }

    // ingestEvents resolves each ARN to its own org via the pipeline-registry
    // and inserts events that span MULTIPLE orgs in a single batch. Once
    // pipeline_events is FORCE'd, a per-org `app.org_id` GUC could only
    // cover one slice of the batch — bypass via the sysadmin GUC instead.
    // This endpoint is server-internal (EventBridge / build-event ingest);
    // the JWT-peek middleware on platform isn't load-bearing here, hence
    // the explicit context establishment.
    const { inserted, skipped, unregisteredArns } = await runWithTenantContext(
      { isSuperAdmin: true },
      () => reportingService.ingestEvents(events),
    );

    // Surface unregistered-ARN drops at WARN with the actual ARNs so an
    // operator can see when EventBridge is delivering events for pipelines
    // that haven't called POST /pipelines/registry yet.
    if (skipped > 0) {
      logger.warn('Skipped events for unregistered ARNs', {
        skipped,
        sampleArns: unregisteredArns.slice(0, 5),
      });
    }

    ctx.log('COMPLETED', `Ingested ${inserted} events, skipped ${skipped}`);
    sendSuccess(res, 200, { inserted, skipped, total: events.length });
  }, { requireOrgId: false }));

  return router;
}
