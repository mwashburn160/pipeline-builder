// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Recovery for publishes a pod died in the middle of.
 *
 * Two claims are taken BEFORE work that can outlive the process:
 *
 *  - an anonymous submission moves `pending_review → publishing` before its
 *    image is copied to `public/community/<name>` (submission-moderation.ts).
 *    The hand-back to `pending_review` on failure is in-process, so a crash
 *    skipped it and the row sat in `publishing` forever: missing from the
 *    backlog gauge, never expired (expiry covers only the pending statuses),
 *    its artifacts and encrypted email never purged, and a moderator retry
 *    answered 409.
 *  - a publish request moves to `approved` before `execute()` runs
 *    (decisions.ts, auto-approval.ts) — the optimistic lock that stops two
 *    managers deciding one request — and the roll-back on a refused execution
 *    is in-process too.
 *
 * A `publishing` submission's own `approved` transition commits in the SAME
 * transaction as the version it publishes, so a row still `publishing` after
 * {@link STALL_GRACE_MS} provably published nothing and goes back to
 * `pending_review`. A request that is `approved` with no `executed_at` after
 * the grace period gets the roll-back its in-process failure path would have
 * applied: back to `pending` (or `pending_second_approval` when a second
 * approval was what claimed it), its decision fields cleared, for a manager
 * to decide again — re-execution of a kind that had partly applied is refused
 * by that kind's own conflict checks, exactly as after an in-process failure.
 *
 * Both counts are also GAUGES (`ecosystem_stalled_publishes{kind}`, sampled
 * by metrics.ts on every replica) with an alert: a value that stays above zero
 * means this recovery itself is not running.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { PluginPublishRequest, PluginPublishRequestInsert } from '@pipeline-builder/pipeline-data';

import { requests } from './store.js';
import { submissions } from './submissions-store.js';

const logger = createLogger('ecosystem-stalled');

/** How long a claim may sit before it is treated as abandoned — far beyond any real publish. */
export const STALL_GRACE_MS = 60 * 60_000;

/** Counter: abandoned claims handed back, by `kind` (`submission` | `request`). */
export const STALLED_RECOVERED_COUNTER = 'ecosystem_stalled_publishes_recovered_total';
/** Gauge: abandoned claims present now, by `kind`. */
export const STALLED_GAUGE = 'ecosystem_stalled_publishes';

/** Submissions stuck in `publishing` past the grace period. */
export async function stalledSubmissions(now: Date) {
  const cutoff = now.getTime() - STALL_GRACE_MS;
  return (await submissions.list({ statuses: ['publishing'] }))
    .filter((s) => new Date(s.updatedAt).getTime() < cutoff);
}

/** Requests `approved` past the grace period whose execution never returned. */
export function stalledRequests(now: Date): Promise<PluginPublishRequest[]> {
  return requests.unexecutedApprovedBefore(new Date(now.getTime() - STALL_GRACE_MS));
}

/** The roll-back a request's in-process execution failure would have applied. */
function rollbackFor(r: PluginPublishRequest): Partial<PluginPublishRequestInsert> {
  const payload = { ...((r.payload ?? {}) as Record<string, unknown>) };
  // Automatic approval (a rule, or the bootstrap exception): auto-approval.ts's own roll-back.
  if (r.autoRuleId || payload.bootstrap === true) {
    delete payload.bootstrap;
    return { status: 'pending', decidedBy: null, decidedAt: null, autoRuleId: null, payload };
  }
  // A second approval claimed it: back to waiting for one.
  if (r.secondApprovedBy) {
    return { status: 'pending_second_approval', secondApprovedBy: null, decidedBy: null, decidedAt: null };
  }
  return { status: 'pending', decidedBy: null, decidedAt: null };
}

/** Hand back every abandoned claim. Returns how many of each it recovered. */
export async function recoverStalledPublishes(now: Date = new Date()): Promise<{ submissions: number; requests: number }> {
  let recoveredSubmissions = 0;
  for (const s of await stalledSubmissions(now)) {
    const back = await submissions.transition(s.id, 'publishing', { status: 'pending_review' });
    if (!back) continue; // decided meanwhile
    recoveredSubmissions++;
    incCounter(STALLED_RECOVERED_COUNTER, { kind: 'submission' });
    logger.warn('Handed back a submission abandoned mid-publish', { submissionId: s.id, since: s.updatedAt });
  }
  let recoveredRequests = 0;
  for (const r of await stalledRequests(now)) {
    const back = await requests.transition(r.id, 'approved', rollbackFor(r));
    if (!back) continue;
    recoveredRequests++;
    incCounter(STALLED_RECOVERED_COUNTER, { kind: 'request' });
    logger.warn('Handed back a publish request abandoned mid-execution', { requestId: r.id, kind: r.kind, decidedAt: r.decidedAt, status: back.status });
  }
  return { submissions: recoveredSubmissions, requests: recoveredRequests };
}
