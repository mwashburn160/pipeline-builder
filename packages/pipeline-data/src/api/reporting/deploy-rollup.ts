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
 *
 * Only the deploy itself is stored. Post-deploy outcomes are not copied here:
 * `/dora` reads change-failure rate and time to restore straight from
 * `deployment_outcomes` and `incidents` (see ./dora.ts).
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { schema } from '../../database/drizzle-schema.js';
import type { LeadTimeGap } from '../../database/schema/reporting-analytics.js';
import { withTenantTx } from '../../database/tenancy.js';

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
  /** The EventBridge event id of the row, when its producer had one. */
  sourceEventId?: string | null;
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
 * ONE ROW PER (org, execution, environment), so a redelivered event refreshes
 * the row rather than adding a second deploy — the same at-least-once problem
 * the event insert solves with its partial unique index. The org leads the
 * conflict target: under forced RLS another org's row is invisible, so a key
 * without it would make that row block this upsert instead of being a separate
 * deploy.
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
      sourceEventId: row.sourceEventId ?? null,
    }];
  });
  if (values.length === 0) return 0;

  // ONE row per conflict key per statement. Postgres refuses an INSERT … ON
  // CONFLICT DO UPDATE that would hit the same row twice ("cannot affect row a
  // second time"), and a batch routinely carries two deploy events for one key:
  // a retried stage's FAILED and SUCCEEDED, or two deploy stages of one
  // execution into the same environment. That error failed — and, since this
  // never throws, silently dropped — EVERY deploy in the batch. Fold the batch
  // the way consecutive upserts would apply: in deploy-time order, the later
  // event deciding the row and the measured fields filling in, never blanked.
  const byKey = new Map<string, (typeof values)[number]>();
  const ordered = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v.deployedAt.getTime() - b.v.deployedAt.getTime() || a.i - b.i)
    .map(({ v }) => v);
  for (const next of ordered) {
    const key = JSON.stringify([next.orgId, next.executionId, next.environment]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, next);
      continue;
    }
    const earliestCommitAt = next.earliestCommitAt ?? prev.earliestCommitAt;
    byKey.set(key, {
      ...next,
      pipelineId: next.pipelineId ?? prev.pipelineId,
      earliestCommitAt,
      leadTimeSeconds: next.leadTimeSeconds ?? prev.leadTimeSeconds,
      commitCount: next.commitCount ?? prev.commitCount,
      commitSha: next.commitSha ?? prev.commitSha,
      leadTimeGap: earliestCommitAt ? null : next.leadTimeGap,
      sourceEventId: next.sourceEventId ?? prev.sourceEventId,
    });
  }
  const rowsToWrite = [...byKey.values()];

  try {
    const landed = await withTenantTx((tx) => tx.insert(schema.doraDeployment).values(rowsToWrite)
      .onConflictDoUpdate({
        target: [schema.doraDeployment.orgId, schema.doraDeployment.executionId, schema.doraDeployment.environment],
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
          // The deploy event that last wrote the row, so the DORA number traces
          // back to it; a producer without an id never blanks a recorded one.
          sourceEventId: sql`COALESCE(excluded.source_event_id, ${schema.doraDeployment.sourceEventId})`,
          updatedAt: new Date(),
        },
        // The LATER deploy event decides the row, not the later-ARRIVING one. A
        // retried deploy stage reports FAILED then SUCCEEDED for the same
        // execution, and a dead-letter redrive can deliver them in either order;
        // last-write-wins let a replayed FAILED overwrite the success. A tie (the
        // same event redelivered) still refreshes, as before.
        setWhere: sql`excluded.deployed_at >= ${schema.doraDeployment.deployedAt}`,
      })
      .returning({ executionId: schema.doraDeployment.executionId }));
    return (landed as unknown[]).length;
  } catch (err) {
    logger.warn('Deploy rollup upsert failed; the events landed and a rebuild can recover it', {
      deploys: rowsToWrite.length,
      error: errorMessage(err),
    });
    return 0;
  }
}
