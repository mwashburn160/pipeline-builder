import { sendSuccess, sendBadRequest, ErrorCode, createLogger, hashAccountInArn } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { CoreConstants, db, schema } from '@mwashburn160/pipeline-core';
import { inArray } from 'drizzle-orm';
import { Router } from 'express';

const logger = createLogger('event-ingest');

interface IngestEvent {
  pipelineArn: string;
  eventSource: string;
  eventType: string;
  status: string;
  executionId?: string;
  stageName?: string;
  actionName?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
}

export function createEventIngestRoutes(): Router {
  const router = Router();

  router.post('/events', withRoute(async ({ req, res, ctx }) => {
    const { events } = req.body as { events?: IngestEvent[] };

    if (!Array.isArray(events) || events.length === 0) {
      return sendBadRequest(res, 'Request body must include a non-empty "events" array', ErrorCode.VALIDATION_ERROR);
    }
    if (events.length > CoreConstants.MAX_EVENTS_PER_BATCH) {
      return sendBadRequest(res, `Maximum ${CoreConstants.MAX_EVENTS_PER_BATCH} events per batch`, ErrorCode.VALIDATION_ERROR);
    }

    // Batch-resolve all unique ARNs in one query
    const uniqueArns = [...new Set(events.map(e => e.pipelineArn))];
    const registryRows = await db
      .select({
        pipelineId: schema.pipelineRegistry.pipelineId,
        orgId: schema.pipelineRegistry.orgId,
        pipelineArn: schema.pipelineRegistry.pipelineArn,
      })
      .from(schema.pipelineRegistry)
      .where(inArray(schema.pipelineRegistry.pipelineArn, uniqueArns));

    const arnMap = new Map(registryRows.map(r => [r.pipelineArn, r]));

    // Build insert batch (skip unregistered ARNs)
    const rows = [];
    let skipped = 0;

    for (const event of events) {
      const registry = arnMap.get(event.pipelineArn);
      if (!registry) { skipped++; continue; }

      rows.push({
        pipelineId: registry.pipelineId,
        orgId: registry.orgId,
        eventSource: event.eventSource as 'codepipeline' | 'codebuild' | 'plugin-build',
        eventType: event.eventType as 'PIPELINE' | 'STAGE' | 'ACTION' | 'BUILD',
        status: event.status,
        pipelineArn: hashAccountInArn(event.pipelineArn),
        executionId: event.executionId,
        stageName: event.stageName,
        actionName: event.actionName,
        startedAt: event.startedAt ? new Date(event.startedAt) : undefined,
        completedAt: event.completedAt ? new Date(event.completedAt) : undefined,
        durationMs: event.durationMs,
        detail: event.detail,
      });
    }

    // Single batch insert
    if (rows.length > 0) {
      await db.insert(schema.pipelineEvent).values(rows);
    }

    if (skipped > 0) {
      logger.debug(`Skipped ${skipped} events for unregistered ARNs`);
    }

    ctx.log('COMPLETED', `Ingested ${rows.length} events, skipped ${skipped}`);
    sendSuccess(res, 200, { inserted: rows.length, skipped, total: events.length });
  }, { requireOrgId: false }));

  return router;
}
