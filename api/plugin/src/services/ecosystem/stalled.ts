// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Recovery for publishes a pod died in the middle of, and the gauge that says
 * a publish is stuck.
 *
 * An anonymous submission moves `pending_review → publishing` before its
 * image is copied to `public/community/<name>` (submission-moderation.ts).
 * The hand-back to `pending_review` on failure is in-process, so a crash
 * skipped it and the row sat in `publishing` forever: missing from the
 * backlog gauge, never expired (expiry covers only the pending statuses), its
 * artifacts and encrypted email never purged, and a moderator retry answered
 * 409. A `publishing` submission's own `approved` transition commits in the
 * SAME transaction as the version it publishes, so a row still `publishing`
 * after {@link STALL_GRACE_MS} provably published nothing and goes back to
 * `pending_review`.
 *
 * An `approved` publish request with no `executed_at` is NOT handed back
 * here: it is the executor's (execution.ts), which retries it with the
 * approval kept, including after a crash. It still counts as stalled after the
 * grace period, because an hour of retries means image-registry or the
 * database has been failing that long.
 *
 * Both are GAUGES (`ecosystem_stalled_publishes{kind}`, sampled by metrics.ts
 * on every replica) with an alert: a value that stays above zero means a
 * publish is stuck, or this recovery is not running.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { PluginPublishRequest } from '@pipeline-builder/pipeline-data';

import { requests } from './store.js';
import { submissions } from './submissions-store.js';

const logger = createLogger('ecosystem-stalled');

/** How long a claim may sit before it counts as stuck — far beyond any real publish. */
export const STALL_GRACE_MS = 60 * 60_000;

/** Counter: abandoned submissions handed back (`kind` is `submission`). */
export const STALLED_RECOVERED_COUNTER = 'ecosystem_stalled_publishes_recovered_total';
/** Gauge: abandoned claims present now, by `kind`. */
export const STALLED_GAUGE = 'ecosystem_stalled_publishes';

/** Submissions stuck in `publishing` past the grace period. */
export async function stalledSubmissions(now: Date) {
  const cutoff = now.getTime() - STALL_GRACE_MS;
  return (await submissions.list({ statuses: ['publishing'] }))
    .filter((s) => new Date(s.updatedAt).getTime() < cutoff);
}

/** Requests `approved` past the grace period whose execution has not completed (the executor is still retrying). */
export function stalledRequests(now: Date): Promise<PluginPublishRequest[]> {
  return requests.unexecutedApprovedBefore(new Date(now.getTime() - STALL_GRACE_MS));
}

/** Hand back every abandoned submission. Returns how many it recovered. */
export async function recoverStalledPublishes(now: Date = new Date()): Promise<{ submissions: number }> {
  let recoveredSubmissions = 0;
  for (const s of await stalledSubmissions(now)) {
    const back = await submissions.transition(s.id, 'publishing', { status: 'pending_review' });
    if (!back) continue; // decided meanwhile
    recoveredSubmissions++;
    incCounter(STALLED_RECOVERED_COUNTER, { kind: 'submission' });
    logger.warn('Handed back a submission abandoned mid-publish', { submissionId: s.id, since: s.updatedAt });
  }
  return { submissions: recoveredSubmissions };
}
