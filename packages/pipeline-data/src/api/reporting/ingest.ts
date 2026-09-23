// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Event ingest: the WRITE half of reporting. Resolves incoming pipeline events
 * against the pipeline registry, scrubs every free-form string, batch-inserts
 * the matched rows idempotently, and invalidates the affected orgs' report
 * caches. Separate from the report queries because this is reporting's only
 * durable persistence boundary — everything else in the service only reads.
 */

import { createLogger, errorMessage, scrubAwsIdentifiers } from '@pipeline-builder/api-core';
import { inArray } from 'drizzle-orm';
import { invalidateOrgReports } from './caches.js';
import { scrubOptional } from './sql-helpers.js';
import type { IngestEvent, IngestMetric, IngestResult } from './types.js';
import { schema } from '../../database/drizzle-schema.js';
import { withTenantTx } from '../../database/tenancy.js';
import type { CrudTx } from '../crud-service.js';

const logger = createLogger('reporting-ingest');

type PipelineEventInsert = typeof schema.pipelineEvent.$inferInsert;


/** The plugin a pipeline step runs, from the step manifest its last deploy registered. */
interface StepPlugin {
  orgId: string;
  pluginPublisher: string | null;
  pluginPublisherId: string | null;
  pluginName: string | null;
  pluginVersion: string | null;
}

/** An action/build event that can be attributed to a plugin step. */
function isAttributable(e: IngestEvent): boolean {
  return (e.eventType === 'ACTION' || e.eventType === 'BUILD')
    && (e.eventSource === 'codepipeline' || e.eventSource === 'codebuild')
    && !!e.stageName && !!e.actionName;
}

function stepKey(pipelineId: string, stageName: string, actionName: string): string {
  return `${pipelineId}\u0000${stageName}\u0000${actionName}`;
}

/**
 * Plugin attribution: the step manifests of every pipeline with an attributable
 * event, in ONE read per batch, keyed for an in-memory join. Names are compared
 * post-scrub on both sides (the manifest stores them scrubbed the same way).
 */
async function loadStepPlugins(tx: CrudTx, attributable: IngestEvent[]): Promise<Map<string, StepPlugin>> {
  const pipelineIds = [...new Set(attributable.map((e) => e.pipelineId))];
  if (pipelineIds.length === 0) return new Map();
  const rows = await tx
    .select({
      pipelineId: schema.pipelineStepManifest.pipelineId,
      orgId: schema.pipelineStepManifest.orgId,
      stageName: schema.pipelineStepManifest.stageName,
      actionName: schema.pipelineStepManifest.actionName,
      pluginPublisher: schema.pipelineStepManifest.pluginPublisher,
      pluginPublisherId: schema.pipelineStepManifest.pluginPublisherId,
      pluginName: schema.pipelineStepManifest.pluginName,
      pluginVersion: schema.pipelineStepManifest.pluginVersion,
    })
    .from(schema.pipelineStepManifest)
    .where(inArray(schema.pipelineStepManifest.pipelineId, pipelineIds));
  return new Map(rows.map((m) => [stepKey(m.pipelineId, m.stageName, m.actionName), m]));
}

/**
 * The persisted row for one ingested event. This is the DURABLE persistence
 * boundary: every user/AWS-derived free-form string is scrubbed here, and
 * tenancy comes from the pipeline registry, never the caller's claimed org.
 */
function toEventRow(event: IngestEvent, registry: { pipelineId: string; orgId: string }, plugin: StepPlugin | undefined): PipelineEventInsert {
  return {
    // registry.pipelineId === event.pipelineId; the registry's is always a row
    // that exists (FK) and its orgId is the trusted tenant.
    pipelineId: registry.pipelineId,
    orgId: registry.orgId,
    eventSource: event.eventSource,
    eventType: event.eventType,
    status: event.status,
    // An AWS-ASSIGNED UUID, not free-form text: it can't carry an account id,
    // and scrubbing a 12-digit run inside it would corrupt the correlation key.
    executionId: event.executionId,
    // USER-AUTHORED pipeline-structure names — same untrusted origin as
    // errorMessage, so scrubbed (a stage named with an ARN must not persist).
    stageName: scrubOptional(event.stageName),
    actionName: scrubOptional(event.actionName),
    // HARD CONSTRAINT: an AWS account id must NEVER be persisted. Failure detail
    // and messages routinely carry ARNs and bare 12-digit account ids.
    errorMessage: scrubOptional(event.errorMessage),
    startedAt: event.startedAt ? new Date(event.startedAt) : undefined,
    completedAt: event.completedAt ? new Date(event.completedAt) : undefined,
    durationMs: event.durationMs,
    // Deploy attribution — scrubbed like the other free-form strings.
    commitSha: scrubOptional(event.commitSha),
    commitRef: scrubOptional(event.commitRef),
    environment: scrubOptional(event.environment),
    // Measured lead time: the oldest unshipped commit's time + the count. An
    // SCM-derived instant and a plain integer — nothing to scrub.
    commitTimestamp: event.commitTimestamp ? new Date(event.commitTimestamp) : undefined,
    commitCount: event.commitCount,
    // NULL for non-plugin actions and for pipelines deployed without a manifest.
    pluginPublisher: plugin?.pluginPublisher ?? null,
    pluginPublisherId: plugin?.pluginPublisherId ?? null,
    pluginName: plugin?.pluginName ?? null,
    pluginVersion: plugin?.pluginVersion ?? null,
    detail: event.detail !== undefined ? scrubAwsIdentifiers(event.detail) : undefined,
  };
}

/**
 * Fan terminal STAGE outcomes into the route's metric hook (pipeline-data can't
 * import api-server's registry) after the insert commits. Driven off the
 * INSERTED rows, so a re-delivered event the dedup index swallowed is never
 * counted twice. A non-null environment marks a deploy.
 */
function emitStageMetrics(
  rows: ReadonlyArray<{ orgId: string; pipelineId: string | null; eventType: string; status: string; stageName: string | null; environment: string | null }>,
  onMetric: (m: IngestMetric) => void,
): void {
  for (const r of rows) {
    if (r.eventType !== 'STAGE' || (r.status !== 'SUCCEEDED' && r.status !== 'FAILED') || !r.pipelineId) continue;
    onMetric({
      pipelineId: r.pipelineId,
      orgId: r.orgId,
      stage: r.stageName ?? '',
      environment: r.environment ?? null,
      result: r.status === 'SUCCEEDED' ? 'succeeded' : 'failed',
    });
  }
}

/**
 * Resolve incoming events against the pipeline registry, batch-insert the
 * matched ones, and invalidate reporting caches for affected orgs.
 * Events for unregistered pipeline ids are dropped (and logged at WARN
 * with sample ids so an operator can see when EventBridge is delivering
 * events for pipelines that haven't called POST /pipelines/registry yet).
 *
 * Returns counts + a sample of unregistered pipeline ids for observability.
 */
export async function ingestEvents(events: IngestEvent[], onMetric?: (m: IngestMetric) => void): Promise<IngestResult> {
  // Multi-org batch insert: the caller resolves to multiple orgs via the
  // pipeline-registry lookup below, so the route layer MUST establish a
  // `runWithTenantContext({ isSuperAdmin: true }, ...)` scope before calling
  // this function. Under FORCE'd RLS, a single tx with `app.org_id = <one
  // org>` could only write events for that org; bypass via sysadmin is
  // the right gate for this server-internal cross-tenant endpoint. See
  // api/reporting/src/routes/event-ingest.ts for the wrapper.
  // Caches are invalidated AFTER the tx resolves: doing it inside held the pg
  // locks open across unrelated cache round-trips. The TTL is 2-5 min, so a
  // fire-and-forget post-commit invalidation is an acceptable trade.
  const { inserted, skipped, unregisteredPipelineIds, affectedOrgs, insertedRows } = await withTenantTx(async (tx) => {
    // Batch-resolve all unique pipeline ids in one query
    const uniqueIds = [...new Set(events.map(e => e.pipelineId))];
    const registryRows = await tx
      .select({
        pipelineId: schema.pipelineRegistry.pipelineId,
        orgId: schema.pipelineRegistry.orgId,
      })
      .from(schema.pipelineRegistry)
      .where(inArray(schema.pipelineRegistry.pipelineId, uniqueIds));

    const idMap = new Map(registryRows.map(r => [r.pipelineId, r]));
    const stepPlugins = await loadStepPlugins(tx, events.filter((e) => isAttributable(e) && idMap.has(e.pipelineId)));

    // Build insert batch (skip events whose pipeline isn't registered)
    const rows: PipelineEventInsert[] = [];
    let skippedLocal = 0;
    const unregisteredLocal: string[] = [];

    for (const event of events) {
      const registry = idMap.get(event.pipelineId);
      if (!registry) {
        skippedLocal++;
        unregisteredLocal.push(event.pipelineId);
        continue;
      }
      const stageName = scrubOptional(event.stageName);
      const actionName = scrubOptional(event.actionName);
      const step = isAttributable(event) && stageName && actionName
        ? stepPlugins.get(stepKey(registry.pipelineId, stageName, actionName))
        : undefined;
      // Same-org guard: a manifest row is only ever written by the org that
      // owns the pipeline, but the ingest runs cross-tenant, so don't lean on it.
      rows.push(toEventRow(event, registry, step && step.orgId === registry.orgId ? step : undefined));
    }

    // SQS is at-least-once, so EventBridge can deliver the same state-change
    // twice. `onConflictDoNothing` + the partial unique index on
    // (pipeline_id, execution_id, event_type, status, stage_name, action_name)
    // makes re-delivery idempotent. `returning` gives the REAL inserted set so
    // counts, metrics and cache invalidation all ignore duplicates.
    const landed = rows.length > 0
      ? await tx.insert(schema.pipelineEvent).values(rows)
        .onConflictDoNothing()
        .returning({
          orgId: schema.pipelineEvent.orgId,
          pipelineId: schema.pipelineEvent.pipelineId,
          eventType: schema.pipelineEvent.eventType,
          status: schema.pipelineEvent.status,
          stageName: schema.pipelineEvent.stageName,
          environment: schema.pipelineEvent.environment,
        })
      : [];

    return {
      inserted: landed.length,
      skipped: skippedLocal,
      unregisteredPipelineIds: unregisteredLocal,
      affectedOrgs: [...new Set(landed.map(r => r.orgId))],
      insertedRows: landed,
    };
  });

  if (onMetric) emitStageMetrics(insertedRows, onMetric);

  // Surface the silent skip: an unregistered pipeline id usually means the
  // pipeline hasn't called POST /pipelines/registry yet (or its
  // pb.pipeline-id tag is missing/unreadable by the Lambda). Logging it
  // makes a broken join visible instead of looking like "no activity".
  if (unregisteredPipelineIds.length > 0) {
    logger.warn('Pipeline events skipped: pipeline id not found in registry', {
      count: unregisteredPipelineIds.length,
      sample: unregisteredPipelineIds.slice(0, 3),
    });
  }

  // Post-commit cache invalidation. Fire-and-forget with logging — TTL is
  // short enough that a missed invalidation self-heals.
  if (affectedOrgs.length > 0) {
    void Promise.all(affectedOrgs.map((org) =>
      invalidateOrgReports(org).catch((err) => {
        logger.warn('Reporting cache invalidation failed', { orgId: org, error: errorMessage(err) });
      }),
    ));
  }

  return { inserted, skipped, unregisteredPipelineIds, affectedOrgs };
}
