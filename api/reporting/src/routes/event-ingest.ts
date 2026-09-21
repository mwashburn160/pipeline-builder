// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, ErrorCode, validateBody, errorMessage } from '@pipeline-builder/api-core';
import { withRoute, incCounter, type SSEManager } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { runWithTenantContext, reportingService, type IngestMetric } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';
import { requireIngestScope } from '../middleware/require-ingest-scope.js';

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
  // `pb.pipeline-id` tag (= the platform pipelineId). The registry join key.
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
  // DORA deploy-attribution (optional; the events Lambda promotes them from the
  // source-action revision + the `pb.deploys` tag). `environment` is set only on
  // deploy-stage events — its presence is what marks a real deployment (there is
  // no `isDeploy` field; it's derived server-side).
  commitSha: z.string().max(255).optional(),
  commitRef: z.string().max(255).optional(),
  environment: z.string().max(255).optional(),
  // DORA measured lead time (Phase 4): oldest unshipped commit time (ISO 8601)
  // + how many commits shipped in this change (≥1). Both resolved in-account by
  // the forwarder; absent when the source type/token can't be resolved.
  commitTimestamp: z.string().datetime({ offset: true }).optional(),
  commitCount: z.number().int().min(1).optional(),
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
  // Bound at the Zod layer so an oversized batch is rejected BEFORE the whole
  // array is validated element-by-element (the route also re-checks post-parse).
  events: z.array(ingestEventSchema)
    .min(1, 'At least one event is required')
    .max(CoreConstants.MAX_EVENTS_PER_BATCH, `Maximum ${CoreConstants.MAX_EVENTS_PER_BATCH} events per batch`),
});


/**
 * @param sseManager - drives the per-org live execution-status channel. After an
 *   ingest lands new events for an org, one `execution-updated` frame is pushed to
 *   that org's SSE subject so the executions dashboard refreshes live instead of
 *   polling. Best-effort; a send failure never affects ingest.
 */
export function createEventIngestRoutes(sseManager: SSEManager): Router {
  const router = Router();

  // Machine endpoint: only a `reporting:ingest`-scoped token (the AWS ingestion
  // Lambda's credential) may write events — see requireIngestScope.
  router.post('/', requireIngestScope, withRoute(async ({ req, res, ctx }) => {
    const parsed = validateBody(req, ingestBatchSchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error, ErrorCode.VALIDATION_ERROR);

    const { events } = parsed.value;
    if (events.length > CoreConstants.MAX_EVENTS_PER_BATCH) {
      return sendBadRequest(res, `Maximum ${CoreConstants.MAX_EVENTS_PER_BATCH} events per batch`, ErrorCode.VALIDATION_ERROR);
    }

    // Phase 3b: fan each registered terminal deploy/stage outcome into Prometheus
    // counters (exposed on this service's /metrics, scraped by in-cluster
    // Prometheus). The org_id is resolved from the registry inside ingestEvents,
    // so the counter is emitted via this hook rather than from the route (which
    // never sees the trusted org). `pipeline_deploy_result_total` is a subset —
    // only stage events that carry a deploy environment.
    const onMetric = (m: IngestMetric): void => {
      incCounter('pipeline_stage_result_total', {
        pipeline_id: m.pipelineId,
        stage: m.stage,
        environment: m.environment ?? '',
        org_id: m.orgId,
        result: m.result,
      });
      if (m.environment) {
        incCounter('pipeline_deploy_result_total', {
          environment: m.environment,
          org_id: m.orgId,
          result: m.result,
        });
      }
    };

    // see ReportingService.ingestEvents for the cross-tenant rationale
    const { inserted, skipped, unregisteredPipelineIds, affectedOrgs } = await runWithTenantContext(
      { isSuperAdmin: true },
      () => reportingService.ingestEvents(events, onMetric),
    );

    if (skipped > 0) {
      ctx.log('WARN', 'Skipped events for unregistered pipeline ids', {
        skipped,
        samplePipelineIds: unregisteredPipelineIds.slice(0, 5),
      });
    }

    // Live-notify each org whose execution state changed (best-effort; cross-pod
    // via the SSEManager relay). The frontend refetches its execution counts on
    // receipt — replacing the dashboard's manual-refresh/poll with a live update.
    // Driven off `affectedOrgs` (every org with a row in this batch), NOT the
    // stage-metric hook it used to use. That hook only fires for STAGE events,
    // so a batch of PIPELINE or BUILD events landed rows and pushed no frame at
    // all — the dashboard quietly fell back to manual refresh for exactly the
    // events an execution view exists to show.
    if (inserted > 0) {
      for (const org of affectedOrgs) {
        try {
          sseManager.send(org, 'MESSAGE', 'execution-updated', { at: new Date().toISOString() });
        } catch (err) {
          ctx.log('WARN', 'Execution-status SSE notify failed (non-fatal)', { org, error: errorMessage(err) });
        }
      }
    }

    ctx.log('COMPLETED', `Ingested ${inserted} events, skipped ${skipped}`);
    sendSuccess(res, 200, { inserted, skipped, total: events.length });
  }, { requireOrgId: false }));

  return router;
}
