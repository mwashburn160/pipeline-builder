// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendError, ErrorCode, hasScope } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { runWithTenantContext, reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';

/** The capability scope the AWS event-ingestion machine credential must carry. */
const INGEST_SCOPE = 'reporting:ingest';
/**
 * During rollout, legacy (non-scoped) user tokens are still accepted with a
 * warning so ingestion keeps working until every deployment re-provisions its
 * events credential (`store-token --scope reporting:ingest`). Set
 * `REPORTING_INGEST_ALLOW_LEGACY=false` to ENFORCE the scope (reject any token
 * without it) — do this once all deployments are migrated. Without enforcement,
 * any authenticated JWT can still post events (the pre-existing behavior).
 */
function legacyIngestAllowed(): boolean {
  return (process.env.REPORTING_INGEST_ALLOW_LEGACY || '').toLowerCase() !== 'false';
}

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
  // Stable pipeline id the events Lambda read from the pipeline's
  // PIPELINE_EVENT_ID tag (= the platform pipelineId). The registry join key.
  pipelineId: z.string().min(1),
  eventType: z.enum(['PIPELINE', 'STAGE', 'ACTION', 'BUILD']),
  executionId: z.string().optional(),
  stageName: z.string().optional(),
  actionName: z.string().optional(),
  // Failure reason (Action events) — promoted from detail.execution-result.
  errorMessage: z.string().max(8192).optional(),
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
    // Ingest is a machine endpoint: only a token carrying the `reporting:ingest`
    // scope may write events (a scoped credential the AWS ingestion Lambda holds).
    // Without this, any authenticated user JWT could forge events for any org,
    // since the org is resolved from the pipeline registry, not the caller.
    if (!hasScope(req, INGEST_SCOPE)) {
      if (!legacyIngestAllowed()) {
        return sendError(res, 403, `Token must carry the '${INGEST_SCOPE}' scope`, ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
      ctx.log('WARN', `Event ingest used a legacy (non-'${INGEST_SCOPE}') token — re-provision with 'store-token --scope ${INGEST_SCOPE}', then set REPORTING_INGEST_ALLOW_LEGACY=false`, {
        sub: req.user?.sub,
      });
    }

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
    const { inserted, skipped, unregisteredPipelineIds } = await runWithTenantContext(
      { isSuperAdmin: true },
      () => reportingService.ingestEvents(events),
    );

    if (skipped > 0) {
      ctx.log('WARN', 'Skipped events for unregistered pipeline ids', {
        skipped,
        samplePipelineIds: unregisteredPipelineIds.slice(0, 5),
      });
    }

    ctx.log('COMPLETED', `Ingested ${inserted} events, skipped ${skipped}`);
    sendSuccess(res, 200, { inserted, skipped, total: events.length });
  }, { requireOrgId: false }));

  return router;
}
