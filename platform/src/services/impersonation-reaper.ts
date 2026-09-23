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

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import type { IntervalSweepDefinition } from './background-sweeps.js';
import { ImpersonationRequest } from '../models/index.js';

const logger = createLogger('impersonation-reaper');

/** Cross-pod leader lock: one replica sweeps per window (the update is idempotent,
 *  so this de-duplicates work rather than guarding correctness). */
const LOCK_KEY = 'platform:leader:impersonation-reaper';

/** Requests live an hour, so a five-minute sweep keeps status at most minutes stale. */
const IMPERSONATION_REAPER_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Flip every `pending` or `approved` request whose window has passed to
 * `expired`. `consumed`, `denied`, `revoked` and `undeliverable` are final and
 * untouched — a consumed request's `expiresAt` is about the approval window, not
 * the session. Returns rows updated. Never throws.
 */
export async function sweepExpiredImpersonationRequests(now: Date = new Date()): Promise<number> {
  try {
    const res = await ImpersonationRequest.updateMany(
      { status: { $in: ['pending', 'approved'] }, expiresAt: { $lte: now } },
      { $set: { status: 'expired' } },
    );
    const modified = res.modifiedCount ?? 0;
    if (modified > 0) logger.info('Expired stale impersonation requests', { modified });
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
  };
}
