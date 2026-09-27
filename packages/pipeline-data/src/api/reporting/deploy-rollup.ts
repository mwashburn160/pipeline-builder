// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Writing `dora_deployments` at ingest.
 *
 * Every DORA number used to be derived by scanning `pipeline_events` per read.
 * Two things were wrong with that, and only one of them was speed:
 *
 *  1. LEAD TIME WAS DOUBLE-COUNTED IN WAITING. A deploy emits a STAGE event and
 *     an ACTION event, and both carry the same resolved commit range. Any
 *     aggregate over events therefore counted one deploy's lead time twice the
 *     moment somebody added the ACTION rows to a query. Storing it once per
 *     execution makes that mistake unavailable rather than merely unmade.
 *  2. THE NUMBERS DID NOT SURVIVE RETENTION. The sweep purges raw events by
 *     tier, so a quarterly report could not be recomputed once its events were
 *     gone — which is exactly when someone asks about it.
 *
 * A deploy is a STAGE event carrying an `environment`: the same predicate the
 * DORA queries have always used, now applied once at write time.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '../../database/drizzle-schema.js';
import { withTenantTx } from '../../database/tenancy.js';
import type { LeadTimeGap } from '../../database/schema/reporting-analytics.js';

const logger = createLogger('deploy-rollup');

/** The fields of an inserted event row this module needs. */
export interface DeployCandidate {
  orgId: string;
  pipelineId: string | null;
  executionId: string | null;
  eventType: string;
  status: string;
  stageName: string | null;
  environment: string | null;
  commitSha?: string | null;
  commitTimestamp?: Date | null;
  commitCount?: number | null;
  completedAt?: Date | null;
  startedAt?: Date | null;
  createdAt?: Date | null;
}

/** Statuses an event uses for "this finished, and it worked". */
const SUCCEEDED = new Set(['SUCCEEDED', 'SUCCESS']);
/** …and for "this finished, and it did not". */
const FAILED = new Set(['FAILED', 'FAILURE', 'CANCELED', 'CANCELLED', 'STOPPED', 'TIMED_OUT']);

/**
 * Is this row a deploy?
 *
 * A STAGE event with an environment, in a terminal state. `IN_PROGRESS` rows are
 * skipped deliberately: a deploy that has started has no duration, no outcome and
 * no place in a deployment-frequency count, and writing it would make every
 * in-flight deploy look like a successful one until its next event landed.
 */
export function isDeployEvent(row: DeployCandidate): boolean {
  return row.eventType === 'STAGE'
    && !!row.environment
    && !!row.executionId
    && (SUCCEEDED.has(row.status) || FAILED.has(row.status));
}

/**
 * Why lead time is absent for a deploy that has no commit timestamp.
 *
 * `no_commit_data` is the honest default: the forwarder resolves the commit range
 * in-account and reports the reason it could not, so anything else here would be
 * this module guessing. The reason it DID report rides on the event's `detail`.
 */
export function leadTimeGapOf(row: DeployCandidate & { detail?: Record<string, unknown> | null }): LeadTimeGap | null {
  if (row.commitTimestamp) return null;
  const reported = row.detail?.leadTimeGap;
  if (reported === 'no_token' || reported === 'rate_limited' || reported === 'unsupported_source') return reported;
  return 'no_commit_data';
}

/** When the deploy finished. Falls back through the event's own timestamps. */
function deployedAtOf(row: DeployCandidate): Date | null {
  return row.completedAt ?? row.startedAt ?? row.createdAt ?? null;
}

/**
 * Upsert the deploy rows for a batch of freshly-inserted events.
 *
 * ONE ROW PER (execution, environment), so a redelivered event refreshes the row
 * rather than adding a second deploy — the same at-least-once problem the event
 * insert solves with its partial unique index.
 *
 * The conflict update deliberately does NOT touch `failed_at` / `restored_at`:
 * those are set by the post-deploy outcome markers and by incident correlation,
 * and a late redelivery of the original deploy event must not erase a recorded
 * production failure.
 *
 * Never throws. An ingest batch that landed its events has done the durable part
 * of its job; failing the whole batch because a derived row could not be written
 * would turn a rollup bug into data loss, and the backfill can rebuild these from
 * the events while they exist.
 */
export async function upsertDeployments(
  rows: ReadonlyArray<DeployCandidate & { detail?: Record<string, unknown> | null }>,
): Promise<number> {
  const deploys = rows.filter(isDeployEvent);
  if (deploys.length === 0) return 0;

  const values = deploys.flatMap((row) => {
    const deployedAt = deployedAtOf(row);
    if (!deployedAt) return [];
    const succeeded = SUCCEEDED.has(row.status);
    const earliestCommitAt = row.commitTimestamp ?? null;
    // Lead time is commit → deploy, and only when both ends are real. A negative
    // gap means the two timestamps came from different clocks; it is dropped
    // rather than clamped to zero, because "0 seconds" is a claim and "unknown"
    // is the truth.
    const leadSeconds = earliestCommitAt
      ? Math.round((deployedAt.getTime() - earliestCommitAt.getTime()) / 1000)
      : null;
    return [{
      orgId: row.orgId,
      executionId: row.executionId as string,
      environment: row.environment as string,
      pipelineId: row.pipelineId,
      deployedAt,
      succeeded,
      earliestCommitAt,
      leadTimeSeconds: leadSeconds !== null && leadSeconds >= 0 ? leadSeconds : null,
      commitCount: row.commitCount ?? null,
      commitSha: row.commitSha ?? null,
      leadTimeGap: leadTimeGapOf(row),
    }];
  });
  if (values.length === 0) return 0;

  try {
    const landed = await withTenantTx((tx) => tx.insert(schema.doraDeployment).values(values)
      .onConflictDoUpdate({
        target: [schema.doraDeployment.executionId, schema.doraDeployment.environment],
        set: {
          succeeded: sql`excluded.succeeded`,
          deployedAt: sql`excluded.deployed_at`,
          pipelineId: sql`COALESCE(excluded.pipeline_id, ${schema.doraDeployment.pipelineId})`,
          // A later event may resolve a commit range the first one could not, so
          // these fill in — but never blank out what was already measured.
          earliestCommitAt: sql`COALESCE(excluded.earliest_commit_at, ${schema.doraDeployment.earliestCommitAt})`,
          leadTimeSeconds: sql`COALESCE(excluded.lead_time_seconds, ${schema.doraDeployment.leadTimeSeconds})`,
          commitCount: sql`COALESCE(excluded.commit_count, ${schema.doraDeployment.commitCount})`,
          commitSha: sql`COALESCE(excluded.commit_sha, ${schema.doraDeployment.commitSha})`,
          // The gap is cleared once a commit timestamp arrives: a resolved lead
          // time and a reason it could not be resolved must never coexist.
          leadTimeGap: sql`CASE WHEN COALESCE(excluded.earliest_commit_at, ${schema.doraDeployment.earliestCommitAt}) IS NOT NULL
            THEN NULL ELSE excluded.lead_time_gap END`,
          updatedAt: new Date(),
        },
      })
      .returning({ executionId: schema.doraDeployment.executionId }));
    return (landed as unknown[]).length;
  } catch (err) {
    logger.warn('Deploy rollup upsert failed; the events landed and a rebuild can recover it', {
      deploys: values.length,
      error: errorMessage(err),
    });
    return 0;
  }
}

/**
 * Record a post-deploy outcome against the deploy it concerns.
 *
 * Denormalized onto `dora_deployments` so change-failure rate and
 * time-to-restore are one scan over the window instead of a join per read. The
 * `deployment_outcomes` table stays the authority — this is the copy the
 * aggregates use, and it is rebuildable from it.
 */
export async function applyDeployOutcome(
  orgId: string,
  executionId: string,
  outcome: 'failed' | 'restored',
  at: Date,
  environment?: string,
): Promise<void> {
  const where = environment
    ? and(
      eq(schema.doraDeployment.executionId, executionId),
      eq(schema.doraDeployment.environment, environment),
      eq(schema.doraDeployment.orgId, orgId),
    )
    : and(
      eq(schema.doraDeployment.executionId, executionId),
      eq(schema.doraDeployment.orgId, orgId),
    );
  // A `restored` marker only means something for a deploy that was marked failed;
  // recording a restore with no failure would produce a negative time-to-restore.
  const set = outcome === 'failed'
    ? { failedAt: at, updatedAt: new Date() }
    : { restoredAt: at, updatedAt: new Date() };
  await withTenantTx((tx) => tx.update(schema.doraDeployment).set(set)
    .where(outcome === 'restored'
      ? and(where, sql`${schema.doraDeployment.failedAt} IS NOT NULL`)
      : where));
}

/**
 * Attribute an incident to the most recent successful deploy to its environment
 * within the correlation window, and label how confident that link is.
 *
 * The confidence is the point. "This deploy broke production" and "an incident
 * opened eleven hours after this deploy, and the window happens to be twelve" are
 * different claims, and a manager acts differently on each — so the report shows
 * which one it is rather than presenting both as a change failure.
 */
export async function correlateIncident(
  orgId: string,
  environment: string,
  openedAt: Date,
  windowHours: number,
): Promise<{ executionId: string; confidence: 'high' | 'medium' | 'low' } | null> {
  const windowStart = new Date(openedAt.getTime() - windowHours * 3600_000);
  const rows = await withTenantTx((tx) => tx.select({
    executionId: schema.doraDeployment.executionId,
    deployedAt: schema.doraDeployment.deployedAt,
  }).from(schema.doraDeployment)
    .where(and(
      eq(schema.doraDeployment.orgId, orgId),
      eq(schema.doraDeployment.environment, environment),
      eq(schema.doraDeployment.succeeded, true),
      sql`${schema.doraDeployment.deployedAt} <= ${openedAt}`,
      sql`${schema.doraDeployment.deployedAt} >= ${windowStart}`,
    ))
    .orderBy(sql`${schema.doraDeployment.deployedAt} DESC`)
    .limit(1));
  const deploy = (rows as Array<{ executionId: string; deployedAt: Date }>)[0];
  if (!deploy) return null;

  // Confidence by how early in the window it fell. The thirds are a judgement,
  // and a stated one: an incident within the first third of the window after a
  // deploy is the case the DORA definition is actually about.
  const elapsed = openedAt.getTime() - deploy.deployedAt.getTime();
  const windowMs = windowHours * 3600_000;
  const confidence = elapsed <= windowMs / 3 ? 'high' : elapsed <= (windowMs * 2) / 3 ? 'medium' : 'low';

  await withTenantTx((tx) => tx.update(schema.doraDeployment)
    .set({ failedAt: openedAt, correlationConfidence: confidence, updatedAt: new Date() })
    .where(and(
      eq(schema.doraDeployment.executionId, deploy.executionId),
      eq(schema.doraDeployment.environment, environment),
      // Do not overwrite a failure already attributed: the FIRST incident linked
      // to a deploy is the one that made it a change failure, and a later one
      // re-dating it would move time-to-restore.
      isNull(schema.doraDeployment.failedAt),
    )));
  return { executionId: deploy.executionId, confidence };
}
