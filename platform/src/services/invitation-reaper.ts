// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Invitation reaper — durably flips stale `pending` invitations (whose
 * `expiresAt` has lapsed) to `expired`.
 *
 * WHY: invitations only expire LAZILY at their natural touch points (re-invite
 * of the same email, token view, accept attempt). There is no `expireAfterSeconds`
 * TTL index — and deliberately so: a raw Mongo TTL on `expiresAt` would DELETE the
 * document, destroying the audit trail of who-was-invited-when. Instead this
 * periodic sweep marks the rows `expired` in place, preserving that history.
 *
 * The seat-capacity and pending-cap queries already guard on `expiresAt > now`
 * (helpers/seats.ts, services/invitation-service.ts), so correctness does NOT
 * depend on this sweep having run — an unswept stale row is never counted as a
 * live seat. The reaper is durability/hygiene: it keeps `status` truthful for
 * listings, dashboards, and any future reader that trusts the status field
 * alone, and lets the data self-heal without a re-invite touching each row.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { Invitation } from '../models/index.js';
import { runWithLeaderLock } from '../utils/leader-lock.js';

const logger = createLogger('invitation-reaper');

/** Cross-pod leader-lock key for the reaper so only one replica flips stale
 *  invites per window (the updateMany is idempotent, so this is a de-dup, not a
 *  correctness gate). */
const LOCK_KEY = 'platform:leader:invitation-reaper';

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Flip every `pending` invitation whose `expiresAt` is at/before now to
 * `expired`. Idempotent and cheap on a no-op (indexed on `status` +
 * `expiresAt`). Returns the number of rows updated. Never throws — errors are
 * logged so a transient Mongo blip can't crash the caller's interval.
 */
export async function sweepExpiredInvitations(): Promise<number> {
  try {
    const res = await Invitation.updateMany(
      { status: 'pending', expiresAt: { $lte: new Date() } },
      { $set: { status: 'expired' } },
    );
    const modified = res.modifiedCount ?? 0;
    if (modified > 0) {
      logger.info('Reaped stale pending invitations', { modified });
    }
    return modified;
  } catch (err) {
    logger.warn('Invitation reaper sweep failed', { error: errorMessage(err) });
    return 0;
  }
}

/**
 * Start the periodic reaper. Idempotent — safe to call multiple times (a second
 * call is a no-op while a timer is live). Runs one immediate sweep, then repeats
 * on the interval. The interval is `.unref()`'d so it never keeps Node alive in
 * tests or worker scripts that import this module without starting the server.
 * Returns the stop function; wire it to SIGTERM in index.ts.
 */
export function startInvitationReaper(intervalMs: number = config.invitation.sweepIntervalMs): () => void {
  if (timer) return stopInvitationReaper;
  const lockTtlMs = Math.max(intervalMs, 60_000);
  const runLocked = () => void runWithLeaderLock(LOCK_KEY, lockTtlMs, async () => { await sweepExpiredInvitations(); });
  timer = setInterval(runLocked, intervalMs).unref();
  runLocked(); // immediate first sweep (leader-locked)
  logger.info('Invitation reaper started', { intervalMs });
  return stopInvitationReaper;
}

/** Stop the periodic reaper. Idempotent. */
export function stopInvitationReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Invitation reaper stopped');
  }
}
