// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, ErrorCode } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { CoreConstants, runWithTenantContext } from '@pipeline-builder/pipeline-core';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';

/**
 * Status values accepted per-eventSource. AWS pipelines use uppercase
 * enums (`SUCCEEDED`, `FAILED`, etc.); the plugin worker uses lowercase
 * BullMQ states. Tightening here prevents a typo at the producer from
 * silently producing zero-result reports — the dashboard queries
 * `getSuccessRate` (uppercase) and `getBuildSuccessRate` (lowercase) are
 * shape-coupled to these strings.
 */
const AWS_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELED', 'IN_PROGRESS', 'STARTED', 'STOPPED', 'STOPPING', 'SUPERSEDED', 'ABANDONED'] as const;
const PLUGIN_BUILD_STATUSES = ['completed', 'failed', 'started', 'timeout', 'cancelled'] as const;

const baseIngestFields = {
  pipelineArn: z.string().min(1),
  eventType: z.enum(['PIPELINE', 'STAGE', 'ACTION', 'BUILD']),
  executionId: z.string().optional(),
  stageName: z.string().optional(),
  actionName: z.string().optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
  durationMs: z.number().int().min(0).optional(),
  detail: z.record(z.string(), z.unknown())
    .refine(d => JSON.stringify(d).length < 8192, 'detail exceeds 8KB serialized size')
    .optional(),
};

/** Discriminated by `eventSource` so the `status` enum is enforced
 *  per-producer instead of accepting any free-form string. */
const ingestEventSchema = z.discriminatedUnion('eventSource', [
  z.object({ eventSource: z.literal('codepipeline'), status: z.enum(AWS_STATUSES), ...baseIngestFields }),
  z.object({ eventSource: z.literal('codebuild'), status: z.enum(AWS_STATUSES), ...baseIngestFields }),
  z.object({ eventSource: z.literal('plugin-build'), status: z.enum(PLUGIN_BUILD_STATUSES), ...baseIngestFields }),
]);

const ingestBatchSchema = z.object({
  events: z.array(ingestEventSchema).min(1, 'At least one event is required'),
});


export function createEventIngestRoutes(): Router {
  const router = Router();

  router.post('/', withRoute(async ({ req, res, ctx }) => {
    const parsed = ingestBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendBadRequest(res, msg, ErrorCode.VALIDATION_ERROR);
    }

    const { events } = parsed.data;
    if (events.length > CoreConstants.MAX_EVENTS_PER_BATCH) {
      return sendBadRequest(res, `Maximum ${CoreConstants.MAX_EVENTS_PER_BATCH} events per batch`, ErrorCode.VALIDATION_ERROR);
    }

    // see ReportingService.ingestEvents for the cross-tenant rationale
    const { inserted, skipped, unregisteredArns } = await runWithTenantContext(
      { isSuperAdmin: true },
      () => reportingService.ingestEvents(events),
    );

    if (skipped > 0) {
      ctx.log('WARN', 'Skipped events for unregistered ARNs', {
        skipped,
        sampleArns: unregisteredArns.slice(0, 5),
      });
    }

    ctx.log('COMPLETED', `Ingested ${inserted} events, skipped ${skipped}`);
    sendSuccess(res, 200, { inserted, skipped, total: events.length });
  }, { requireOrgId: false }));

  return router;
}
