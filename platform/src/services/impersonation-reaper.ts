// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Impersonation request reaper — durably flips requests whose window lapsed
 * without being used to `expired`.
 *
 * Requests otherwise expire only LAZILY, when someone touches them (a decide or
 * redeem attempt). A request nobody answered — or an approval nobody opened —
 * would stay `pending` / `approved` in the database forever. The approver's list
 * already hides those (it filters on `expiresAt`), so correctness does not depend
 * on this sweep. It keeps `status` TRUTHFUL for everything that reads it: the
 * requester's own list, the audit trail, and any report on how requests resolve.
 *
 * Same shape as the invitation reaper, for the same reason: no Mongo TTL index,
 * because deleting these rows would erase the record of who asked for access and
 * what came of it.
 */

import { createLogger, errorMessage, leaderLockKey, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { QueryFilter } from 'mongoose';
import type { IntervalSweepDefinition } from './background-sweeps.js';
import { recordAuditEvent } from '../helpers/audit.js';
import { ImpersonationRequest, type ImpersonationRequestData } from '../models/index.js';

const logger = createLogger('impersonation-reaper');

/** Cross-pod leader lock: one replica sweeps per window (the update is idempotent,
 *  so this de-duplicates work rather than guarding correctness). */
const LOCK_KEY = leaderLockKey('platform', 'impersonation-reaper');

/** Requests live an hour, so a five-minute sweep keeps status at most minutes stale. */
const IMPERSONATION_REAPER_INTERVAL_MS = 5 * 60 * 1000;

/** Requests expired per pass — bounds the per-row audit fan-out; a backlog
 *  drains over successive sweeps. */
const REAP_BATCH = 500;

/**
 * Flip every `pending` or `approved` request whose window has passed to
 * `expired`. `consumed`, `denied`, `revoked` and `undeliverable` are final and
 * untouched — a consumed request's `expiresAt` is about the approval window, not
 * the session. Returns rows updated. Never throws.
 *
 * Each expiry is audited (`admin.impersonate.expire`, system actor) against the
 * org the request was for, so a request that lapsed unanswered shows on that
 * org's trail by id rather than as an anonymous count in a log line.
 */
export async function sweepExpiredImpersonationRequests(now: Date = new Date()): Promise<number> {
  try {
    const filter: QueryFilter<ImpersonationRequestData> = { status: { $in: ['pending', 'approved'] }, expiresAt: { $lte: now } };
    const lapsed = await ImpersonationRequest.find(filter)
      .select('_id status requesterId targetUserId organizationId breakglass')
      .limit(REAP_BATCH)
      .lean();
    if (lapsed.length === 0) return 0;
    const res = await ImpersonationRequest.updateMany(
      { ...filter, _id: { $in: lapsed.map((r) => r._id) } },
      { $set: { status: 'expired' } },
    );
    const modified = res.modifiedCount ?? 0;
    if (modified > 0) {
      logger.info('Expired stale impersonation requests', { modified });
      for (const r of lapsed) {
        recordAuditEvent({
          action: 'admin.impersonate.expire',
          actorId: SYSTEM_ACTOR_ID,
          orgId: SYSTEM_ORG_ID,
          ...(r.organizationId ? { affectedOrgId: String(r.organizationId) } : {}),
          targetType: 'user',
          targetId: String(r.targetUserId),
          outcome: 'success',
          details: {
            impersonationRequestId: String(r._id),
            previousStatus: r.status,
            requesterId: String(r.requesterId),
            ...(r.breakglass ? { breakglass: true } : {}),
            reason: 'impersonation-reaper',
          },
        });
      }
    }
    return modified;
  } catch (err) {
    logger.warn('Impersonation reaper sweep failed', { error: errorMessage(err) });
    return 0;
  }
}

/** The reaper as a background sweep (see services/background-sweeps.ts). */
export function impersonationReaperSweep(intervalMs: number = IMPERSONATION_REAPER_INTERVAL_MS): IntervalSweepDefinition {
  return {
    name: 'impersonation-reaper',
    lockKey: LOCK_KEY,
    intervalMs,
    run: async () => { await sweepExpiredImpersonationRequests(); },
    // One idempotent `updateMany` — safe on every replica (see invitation-reaper).
    concurrencySafe: true,
  };
}
