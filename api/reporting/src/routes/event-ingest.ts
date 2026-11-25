// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, ErrorCode, validateBody, errorMessage, verifyServicePrincipal, audited, AWS_REGION_PATTERN } from '@pipeline-builder/api-core';
import { withRoute, incCounter, resetGauge, setGauge, type SSEManager } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { runWithTenantContext, reportingService, type EventSource, type IngestCaller, type IngestMetric } from '@pipeline-builder/pipeline-data';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { countIngestRejection, ingestKeyId, recordIngestBatch, recordIngestRejection } from '../helpers/ingest-audit.js';
import { resolveOrgRollup } from '../helpers/report-helpers.js';
import { requireIngestScope } from '../middleware/require-ingest-scope.js';
import { registerFirstEventPipelines, type FirstEventCandidate } from '../services/first-event-registration.js';

/**
 * Status values accepted per-eventSource. AWS pipelines use uppercase
 * enums (`SUCCEEDED`, `FAILED`, etc.); the plugin worker uses lowercase
 * BullMQ states. Tightening here prevents a typo at the producer from
 * silently producing zero-result reports — the dashboard queries
 * `getSuccessRate` (uppercase) and `getBuildSuccessRate` (lowercase) are
 * shape-coupled to these strings.
 *
 * `RESUMED` is what CodePipeline sends when a failed stage is retried: the SAME
 * execution re-opens after its terminal FAILED. Refusing it failed the whole
 * forwarded batch (400) and dropped the one signal that the failure was not
 * final. It is non-terminal; the execution reports read the retried outcome via
 * `notOvertaken` (packages/pipeline-data/src/api/reporting/sql-helpers.ts).
 */
const AWS_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELED', 'IN_PROGRESS', 'STARTED', 'RESUMED', 'STOPPED', 'STOPPING', 'SUPERSEDED', 'ABANDONED'] as const;

const PLUGIN_BUILD_STATUSES = ['completed', 'failed', 'started', 'timeout', 'cancelled'] as const;

const baseIngestFields = {
  // Stable pipeline id the events Lambda read from the pipeline's
  // `pb.pipeline-id` tag (= the platform pipelineId). The registry join key.
  pipelineId: z.string().min(1),
  // The AWS region the event came from (the EventBridge envelope's). Not stored
  // on the event row: it is what a first-event self-registration records as the
  // pipeline's region (trigger/cancel address the CodePipeline there).
  region: z.string().min(1).max(30).optional(),
  eventType: z.enum(['PIPELINE', 'STAGE', 'ACTION', 'BUILD']),
  // The columns' own bounds (VARCHAR(255)): past them the INSERT failed as a 500
  // the forwarder retries forever, rather than a 400 it can dead-letter.
  executionId: z.string().max(255).optional(),
  stageName: z.string().max(255).optional(),
  actionName: z.string().max(255).optional(),
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
  // DORA measured lead time: oldest unshipped commit time (ISO 8601)
  // + how many commits shipped in this change (≥1). Both resolved in-account by
  // the forwarder; absent when the source type/token can't be resolved.
  commitTimestamp: z.string().datetime({ offset: true }).optional(),
  commitCount: z.number().int().min(1).optional(),
  detail: z.record(z.string(), z.unknown())
    .refine(d => JSON.stringify(d).length < 8192, 'detail exceeds 8KB serialized size')
    .optional(),
  // Structured failure (FAILED events): a machine-readable `code` (e.g. a plugin
  // resolution refusal such as `PLUGIN_NOT_INSTALLED`, a contract violation, a
  // build error), the human message, and the plugins involved. Stored as
  // `detail.failure` — see foldFailure.
  // Provenance from the AWS forwarder: the EventBridge event id (stored as
  // `source_event_id`, the dedup key and the thread back to the exact AWS event)
  // and the SQS message id it arrived in (kept in detail). Both opaque ids.
  sourceEventId: z.string().min(1).max(128).optional(),
  sourceMessageId: z.string().min(1).max(128).optional(),
  // The compute size a terminal CodeBuild action ran on, read from AWS by the
  // forwarder in AWS's own spelling (`BUILD_GENERAL1_MEDIUM`). MEASURED, NOT
  // CHARGED: duration x this size is the vCPU-minute figure the tier ladder has
  // to be re-derived from before pipeline execution can be charged into
  // `cpuCredits` at all. Stored as `detail.computeType` (see foldCompute)
  // and narrowed to our vocabulary where the credits are computed.
  //
  // A bounded STRING rather than an enum, deliberately: the producer is a
  // single-file Lambda that cannot import the vocabulary, and a new AWS compute
  // family must land as an unrecognised size the coverage metric reports —
  // not as a rejected batch that drops every event beside it.
  computeType: z.string().min(1).max(64).optional(),
  // How long a terminal CodeBuild action's build WAITED before it ran: the
  // QUEUED and PROVISIONING phase lengths in ms, read by the forwarder off the
  // same BatchGetBuilds record as `computeType`. Stored as `detail.buildPhases`
  // (see foldBuildPhases) and read by the Flow report's queue-time panel. A phase
  // AWS did not report is absent, never zero. Strict: an unknown key is a
  // producer bug, refused rather than silently stored.
  buildPhases: z.object({
    queuedMs: z.number().int().min(0).optional(),
    provisioningMs: z.number().int().min(0).optional(),
  }).strict().optional(),
  failure: z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(2048),
    plugins: z.array(z.object({
      name: z.string().min(1).max(255),
      version: z.string().max(50).optional(),
      publisher: z.string().max(39).optional(),
    })).max(50).optional(),
  }).optional(),
};

/**
 * Which status vocabulary each producer speaks, keyed by the stored
 * `event_source` vocabulary — `satisfies` makes a source added there without a
 * status set here a compile error rather than a batch rejected at runtime.
 */
const STATUSES_BY_SOURCE = {
  'codepipeline': AWS_STATUSES,
  'codebuild': AWS_STATUSES,
  'plugin-build': PLUGIN_BUILD_STATUSES,
} as const satisfies Record<EventSource, readonly [string, ...string[]]>;

/** One schema per source, so the `status` enum is enforced per-producer. */
const sourceSchema = <S extends EventSource>(source: S) =>
  z.object({ eventSource: z.literal(source), status: z.enum(STATUSES_BY_SOURCE[source]), ...baseIngestFields });

/** Discriminated by `eventSource` so the `status` enum is enforced
 *  per-producer instead of accepting any free-form string. */
const ingestEventSchema = z.discriminatedUnion('eventSource', [
  sourceSchema('codepipeline'),
  sourceSchema('codebuild'),
  sourceSchema('plugin-build'),
]);

const ingestBatchSchema = z.object({
  // Bound at the Zod layer so an oversized batch is rejected BEFORE the whole
  // array is validated element-by-element.
  events: z.array(ingestEventSchema)
    .min(1, 'At least one event is required')
    .max(CoreConstants.MAX_EVENTS_PER_BATCH, `Maximum ${CoreConstants.MAX_EVENTS_PER_BATCH} events per batch`),
});


/**
 * Move an event's structured `failure` into `detail.failure`, where the event
 * row keeps it (jsonb, no column of its own) and the execution reads pick it up.
 * Its own field on the wire, so the producer cannot have it truncated by — or
 * truncate — its free-form detail.
 */
function foldFailure<E extends { failure?: unknown; detail?: Record<string, unknown> }>(event: E): Omit<E, 'failure'> {
  const { failure, ...rest } = event;
  return failure === undefined ? rest : { ...rest, detail: { ...(rest.detail ?? {}), failure } };
}

/**
 * Same fold for `computeType`, and folded AFTER validation on purpose: the
 * incoming `detail` is size-refined at 8 KB, so a field added here cannot be the
 * one an oversized payload sheds.
 */
function foldCompute<E extends { computeType?: unknown; detail?: Record<string, unknown> }>(event: E): Omit<E, 'computeType'> {
  const { computeType, ...rest } = event;
  return computeType === undefined ? rest : { ...rest, detail: { ...(rest.detail ?? {}), computeType } };
}

/** Same fold for `buildPhases` (the queue / provisioning wait), after validation like {@link foldCompute}. */
function foldBuildPhases<E extends { buildPhases?: unknown; detail?: Record<string, unknown> }>(event: E): Omit<E, 'buildPhases'> {
  const { buildPhases, ...rest } = event;
  return buildPhases === undefined ? rest : { ...rest, detail: { ...(rest.detail ?? {}), buildPhases } };
}

/** The ingest's region is a registration hint, never part of the stored event. */
function dropRegion<E extends { region?: unknown }>(event: E): Omit<E, 'region'> {
  const { region: _region, ...rest } = event;
  return rest;
}

/**
 * The contract's own id check (`z.string().uuid()`: RFC 9562 version + variant),
 * not a looser hex shape: one id the pipeline service refuses fails its whole
 * request with a 400, and every other candidate in the batch with it.
 */
const isPipelineUuid = (id: string): boolean => z.uuid().safeParse(id).success;

/**
 * The pipelines a skipped batch may self-register: unregistered ids that a
 * `codepipeline` event names (the events Lambda only forwards those after
 * reading the pipeline's `pb.pipeline-id` tag) and that are pipeline UUIDs,
 * once each, with the first well-formed AWS region any of its events carried
 * (the region trigger/cancel later address, so a malformed one is dropped, not
 * recorded). None for a cross-tenant caller or one with no org: self-registration
 * is confined to the orgs the events were authenticated for.
 */
function firstEventCandidates(
  events: ReadonlyArray<{ pipelineId: string; eventSource: string; region?: string }>,
  unregisteredIds: readonly string[],
  caller: IngestCaller,
): FirstEventCandidate[] {
  if (caller.crossTenant || caller.allowedOrgIds.length === 0 || unregisteredIds.length === 0) return [];
  const unregistered = new Set(unregisteredIds);
  const byId = new Map<string, FirstEventCandidate>();
  for (const e of events) {
    if (e.eventSource !== 'codepipeline' || !unregistered.has(e.pipelineId) || !isPipelineUuid(e.pipelineId)) continue;
    const region = e.region && AWS_REGION_PATTERN.test(e.region) ? e.region : undefined;
    const seen = byId.get(e.pipelineId);
    if (!seen) byId.set(e.pipelineId, { pipelineId: e.pipelineId, ...(region ? { region } : {}) });
    else if (!seen.region && region) seen.region = region;
  }
  return [...byId.values()];
}

/** What one ingest pass reports. */
type IngestResult = Awaited<ReturnType<typeof reportingService.ingestEvents>>;

/** Fold a second ingest pass (the self-registered pipelines' events) into the first's result. */
function mergeIngest(first: IngestResult, second: IngestResult, registered: ReadonlySet<string>, retried: number): IngestResult {
  const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
  return {
    inserted: first.inserted + second.inserted,
    skipped: first.skipped - retried + second.skipped,
    unregisteredPipelineIds: [...first.unregisteredPipelineIds.filter((id) => !registered.has(id)), ...second.unregisteredPipelineIds],
    affectedOrgs: union(first.affectedOrgs, second.affectedOrgs),
    droppedForeignOrg: first.droppedForeignOrg + second.droppedForeignOrg,
    droppedInvalidTime: first.droppedInvalidTime + second.droppedInvalidTime,
    foreignPipelineIds: union(first.foreignPipelineIds, second.foreignPipelineIds),
    insertedPipelineIds: union(first.insertedPipelineIds, second.insertedPipelineIds),
    insertedExecutionIds: union(first.insertedExecutionIds, second.insertedExecutionIds),
  };
}

/**
 * The alert baseline for `PipelineToolchainFailureSpike`: which release THIS
 * pod last saw as the platform default, valued with WHEN it saw it. Prometheus
 * knows nothing of the default, and every reporting replica publishes its own
 * view — so the rule picks the freshest observation across pods
 * (`topk(1, max by (toolchain_release) (…))`) rather than trusting any one pod.
 * Reset first: one series per pod, the current answer only.
 */
function observeToolchainPlatformDefault(releaseVersion: string): void {
  resetGauge('pipeline_toolchain_platform_default_seen_timestamp_seconds');
  setGauge('pipeline_toolchain_platform_default_seen_timestamp_seconds', { toolchain_release: releaseVersion }, Date.now() / 1000);
}

/**
 * WHICH ORGS THIS CALLER MAY TOUCH. An event's org is resolved from the pipeline
 * registry, so the `reporting:ingest` scope alone let any holder post events for
 * another org's pipeline id and have them attributed there — and, on the read
 * side, pull back that org's last deployed commit. Both routes establish the
 * allowed set here so they cannot drift.
 *
 * A verified INTERNAL service principal is exempt: the plugin service posts
 * plugin-build events for every tenant, and its signed service key is one no
 * external client can mint. Everyone else is confined to their own org plus its
 * descendant teams.
 */
async function resolveIngestCaller(req: Request): Promise<IngestCaller> {
  const crossTenant = verifyServicePrincipal(req);
  let allowedOrgIds: string[] = [];
  if (!crossTenant) {
    const callerOrg = req.user?.organizationId;
    if (callerOrg) {
      // FAIL CLOSED. resolveOrgRollup is deliberately fail-soft for reports
      // (undefined on any error), which is the wrong direction for a tenancy
      // boundary: an unreachable platform must narrow the caller to its own
      // org, never widen it. A parent org loses its teams' events during that
      // outage — they are dropped and counted, not silently accepted.
      const rollup = await resolveOrgRollup(callerOrg);
      allowedOrgIds = rollup ?? [callerOrg];
    }
    // No org on the token at all ⇒ empty allow-list ⇒ nothing is written or read.
  }
  const keyId = ingestKeyId(req);
  return { allowedOrgIds, ...(crossTenant ? { crossTenant: true } : {}), ...(keyId ? { keyId } : {}) };
}

/**
 * @param sseManager - drives the per-org live execution-status channel. After an
 *   ingest lands new events for an org, one `execution-updated` frame is pushed to
 *   that org's SSE subject so the executions dashboard refreshes live instead of
 *   polling. Best-effort; a send failure never affects ingest.
 */
export function createEventIngestRoutes(sseManager: SSEManager): Router {
  const router = Router();

  // Machine endpoint: only a `reporting:ingest`-scoped token (the AWS ingestion
  // Lambda's credential) may write events — see requireIngestScope. Every POST
  // records one `reporting.ingest.batch` row (helpers/ingest-audit.ts); a
  // tenancy refusal inside it records `reporting.ingest.rejected`.
  router.post('/', requireIngestScope, audited('reporting.ingest.batch', 'reporting.ingest.rejected'), withRoute(async ({ req, res, ctx }) => {
    const parsed = validateBody(req, ingestBatchSchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error, ErrorCode.VALIDATION_ERROR);

    const { events } = parsed.value;

    // Fan each registered terminal deploy/stage outcome into Prometheus
    // counters (exposed on this service's /metrics, scraped by in-cluster
    // Prometheus). The org_id is resolved from the registry inside ingestEvents,
    // so the counter is emitted via this hook rather than from the route (which
    // never sees the trusted org). `pipeline_deploy_result_total` is a subset —
    // only stage events that carry a deploy environment.
    const onMetric = (m: IngestMetric): void => {
      if (m.kind === 'toolchain') {
        // Managed toolchain runs,
        // ALERTING ONLY: the canary gate and the Affected view read the stamped
        // rows, which carry org_id — this series deliberately does not. The
        // release label is the platform's deployed manifest, never the payload.
        incCounter('pipeline_toolchain_runs_total', {
          toolchain_release: m.toolchainRelease,
          action: m.action,
          outcome: m.outcome,
        });
        if (m.platformDefaultRelease) observeToolchainPlatformDefault(m.platformDefaultRelease);
        return;
      }
      if (m.kind === 'compute') {
        // MEASURED, NOT CHARGED. Nothing here enters a quota counter: the
        // tier ladder was derived without pipeline execution in it, so charging
        // this before re-deriving the ladder would raise every account's
        // consumption with no change in its behaviour — a silent repricing.
        // These two series are what the re-derivation needs.
        //
        // `measured` is the coverage label, and it is the first thing to read.
        // The forwarder refuses to compute a duration unless AWS declared a
        // `start-time`, so a real fraction of actions arrive unmeasurable; a
        // ladder priced off this series before that fraction is known would be
        // priced off an unknown denominator.
        incCounter('pipeline_compute_actions_total', {
          org_id: m.orgId,
          compute_type: m.computeType ?? 'unknown',
          measured: m.credits == null ? 'false' : 'true',
        });
        if (m.credits != null) {
          incCounter('pipeline_compute_credits_total', {
            org_id: m.orgId,
            compute_type: m.computeType ?? 'unknown',
          }, m.credits);
        }
        return;
      }
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

    const caller = await resolveIngestCaller(req);

    // see ReportingService.ingestEvents for the cross-tenant rationale
    const ingest = (batch: typeof events) => runWithTenantContext(
      { isSuperAdmin: true },
      () => reportingService.ingestEvents(batch.map(dropRegion).map(foldFailure).map(foldCompute).map(foldBuildPhases), onMetric, caller),
    );
    let result = await ingest(events);

    // FIRST-EVENT SELF-REGISTRATION. A tagged pipeline with no registry row (created
    // in the dashboard, deployed by CDK, a runner or CI rather than `pipeline-manager
    // pipeline deploy`) had every event skipped, so its reports stayed empty. Ask the
    // pipeline service to register it — it does so only for a live pipeline of one of
    // the caller's allowed orgs — and ingest the events it registered. Anything it
    // did not register (or a failed call) stays skipped and counted, as before.
    const candidates = firstEventCandidates(events, result.unregisteredPipelineIds, caller);
    if (candidates.length > 0) {
      // Only ids this route offered: every event of one of them was skipped by the
      // first pass, which is what the second pass and `mergeIngest` rely on.
      const offered = new Set(candidates.map((c) => c.pipelineId));
      const registered = new Set((await registerFirstEventPipelines(candidates, caller.allowedOrgIds)).filter((id) => offered.has(id)));
      const retry = events.filter((e) => registered.has(e.pipelineId));
      if (retry.length > 0) {
        ctx.log('INFO', 'Registered pipelines on their first event; ingesting their events', { pipelineIds: [...registered] });
        result = mergeIngest(result, await ingest(retry), registered, retry.length);
      }
    }
    const {
      inserted, skipped, unregisteredPipelineIds, affectedOrgs, droppedForeignOrg, droppedInvalidTime,
      foreignPipelineIds, insertedPipelineIds, insertedExecutionIds,
    } = result;

    // A non-zero count is either a misrouted producer or an injection attempt;
    // both need a metric, not just a log line inside the data layer.
    if (droppedForeignOrg > 0) {
      // No org label: the alert sums it, and WHICH caller org is the durable
      // rejection record's job (countIngestRejection below + the log line).
      incCounter('reporting_ingest_foreign_org_dropped_total', {});
      ctx.log('WARN', 'Dropped events for pipelines outside the caller org scope', {
        dropped: droppedForeignOrg,
        callerOrgId: req.user?.organizationId ?? null,
      });
      // …and a durable record of WHICH pipelines and WHICH credential: the
      // counter cannot tell a misrouted forwarder from a stolen key.
      countIngestRejection('foreign_org', droppedForeignOrg);
      recordIngestRejection(req, { source: 'events', reason: 'foreign_org', dropped: droppedForeignOrg, pipelineIds: foreignPipelineIds });
    }

    // A bad clock on a build host silently skews DF/CFR/lead time for the whole
    // org, so the drop needs to be visible as a number, not only a data-layer log.
    if (droppedInvalidTime > 0) {
      incCounter('reporting_ingest_invalid_time_dropped_total', { org_id: req.user?.organizationId ?? 'unknown' });
      countIngestRejection('invalid_time', droppedInvalidTime);
      ctx.log('WARN', 'Dropped events with impossible timestamps', {
        dropped: droppedInvalidTime,
        callerOrgId: req.user?.organizationId ?? null,
      });
    }

    if (skipped > 0) {
      countIngestRejection('unregistered_pipeline', skipped);
      ctx.log('WARN', 'Skipped events for unregistered pipeline ids', {
        skipped,
        samplePipelineIds: unregisteredPipelineIds.slice(0, 5),
      });
    }

    // Live-notify each org whose execution state changed (best-effort; cross-pod
    // via the SSEManager relay). The frontend refetches its execution counts on
    // receipt — replacing the dashboard's manual-refresh/poll with a live update.
    // Driven off `affectedOrgs` (every org with a row in this batch), NOT the
    // stage-metric hook: that only fires for STAGE events, so a batch of PIPELINE
    // or BUILD events would land rows and push no frame at all.
    if (inserted > 0) {
      for (const org of affectedOrgs) {
        try {
          sseManager.send(org, 'MESSAGE', 'execution-updated', { at: new Date().toISOString() });
        } catch (err) {
          ctx.log('WARN', 'Execution-status SSE notify failed (non-fatal)', { org, error: errorMessage(err) });
        }
      }
    }

    recordIngestBatch(req, {
      source: 'events',
      ...(affectedOrgs.length === 1 ? { affectedOrgId: affectedOrgs[0] } : { affectedOrgIds: affectedOrgs }),
      // A batch where nothing landed AND something was refused is a failed write;
      // a batch of pure re-deliveries (all deduped) is not.
      outcome: inserted === 0 && droppedForeignOrg + droppedInvalidTime + skipped > 0 ? 'failure' : 'success',
      counts: {
        received: events.length,
        inserted,
        deduplicated: events.length - inserted - skipped - droppedForeignOrg - droppedInvalidTime,
        skippedUnregistered: skipped,
        droppedForeignOrg,
        droppedInvalidTime,
      },
      pipelineIds: insertedPipelineIds,
      executionIds: insertedExecutionIds,
      sourceEventIds: events.map((e) => e.sourceEventId),
    });

    ctx.log('COMPLETED', `Ingested ${inserted} events, skipped ${skipped}`);
    sendSuccess(res, 200, { inserted, skipped, total: events.length });
  }, { requireOrgId: false }));

  // The events Lambda's cold-start recovery: the exclusive lower bound for
  // "commits since the last deploy". Its in-memory `lastShaByPipeline` is empty
  // in a fresh container, and without this the next deploy resolved as a single
  // commit — lead time far too short, `commitCount` stuck at 1. Same ingest scope
  // and the same tenancy allow-list as the write path.
  router.get('/last-deploy-commit', requireIngestScope, withRoute(async ({ req, res, ctx }) => {
    const pipelineId = typeof req.query.pipelineId === 'string' ? req.query.pipelineId : '';
    if (!pipelineId) {
      return sendBadRequest(res, 'pipelineId is required', ErrorCode.VALIDATION_ERROR);
    }
    // Optional: a source event has no environment yet, so the Lambda usually asks
    // "last shipped anywhere". Given, it narrows to that environment.
    const environment = typeof req.query.environment === 'string' && req.query.environment.length > 0
      ? req.query.environment
      : undefined;

    const caller = await resolveIngestCaller(req);
    const result = await runWithTenantContext(
      { isSuperAdmin: true },
      () => reportingService.getLastDeployedCommit(pipelineId, environment, caller),
    );

    ctx.log('COMPLETED', 'Resolved last deployed commit', {
      pipelineId, environment: environment ?? null, found: result.commitSha !== null,
    });
    // 200 with nulls rather than 404: "this pipeline has never deployed here" is a
    // normal answer the Lambda acts on (resolve a single commit), not an error, and
    // a 404 would be indistinguishable from a wrong URL.
    return sendSuccess(res, 200, result);
  }));

  return router;
}
