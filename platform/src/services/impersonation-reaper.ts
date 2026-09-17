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
import { ImpersonationRequest } from '../models/index.js';
import { runWithLeaderLock } from '../utils/leader-lock.js';

const logger = createLogger('impersonation-reaper');

/** Cross-pod leader lock: one replica sweeps per window (the update is idempotent,
 *  so this de-duplicates work rather than guarding correctness). */
const LOCK_KEY = 'platform:leader:impersonation-reaper';

/** Requests live an hour, so a five-minute sweep keeps status at most minutes stale. */
export const IMPERSONATION_REAPER_INTERVAL_MS = 5 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

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

/** Start the periodic reaper. Idempotent; returns the stop function for SIGTERM. */
export function startImpersonationReaper(intervalMs: number = IMPERSONATION_REAPER_INTERVAL_MS): () => void {
  if (timer) return stopImpersonationReaper;
  const lockTtlMs = Math.max(intervalMs, 60_000);
  const runLocked = () => void runWithLeaderLock(LOCK_KEY, lockTtlMs, async () => { await sweepExpiredImpersonationRequests(); });
  timer = setInterval(runLocked, intervalMs).unref();
  runLocked();
  logger.info('Impersonation reaper started', { intervalMs });
  return stopImpersonationReaper;
}

/** Stop the periodic reaper. Idempotent. */
export function stopImpersonationReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
