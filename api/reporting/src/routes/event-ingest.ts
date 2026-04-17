// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, ErrorCode, createLogger, hashAccountInArn, errorMessage } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { CoreConstants, db, schema } from '@pipeline-builder/pipeline-core';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { inArray } from 'drizzle-orm';
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
        eventSource: event.eventSource,
        eventType: event.eventType,
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

      // Invalidate reporting caches for affected orgs
      const affectedOrgs = new Set(rows.map(r => r.orgId));
      for (const org of affectedOrgs) {
        reportingService.invalidateOrg(org).catch((err) => {
          logger.warn('Reporting cache invalidation failed', { orgId: org, error: errorMessage(err) });
        });
      }
    }

    if (skipped > 0) {
      logger.debug('Skipped events for unregistered ARNs', { skipped });
    }

    ctx.log('COMPLETED', `Ingested ${rows.length} events, skipped ${skipped}`);
    sendSuccess(res, 200, { inserted: rows.length, skipped, total: events.length });
  }, { requireOrgId: false }));

  return router;
}
