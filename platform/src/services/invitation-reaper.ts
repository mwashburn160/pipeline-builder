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

import { createLogger, errorMessage, leaderLockKey, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { QueryFilter } from 'mongoose';
import type { IntervalSweepDefinition } from './background-sweeps.js';
import { config } from '../config/index.js';
import { recordAuditEvent } from '../helpers/audit.js';
import { Invitation, type InvitationData } from '../models/index.js';

const logger = createLogger('invitation-reaper');

/** Cross-pod leader-lock key for the reaper so only one replica flips stale
 *  invites per window (the updateMany is idempotent, so this is a de-dup, not a
 *  correctness gate). */
const LOCK_KEY = leaderLockKey('platform', 'invitation-reaper');

/** Invitations expired per pass — bounds the per-row audit fan-out; a backlog
 *  drains over successive sweeps. */
const REAP_BATCH = 500;

/**
 * Flip every `pending` invitation whose `expiresAt` is at/before now to
 * `expired`. Idempotent and cheap on a no-op (indexed on `status` +
 * `expiresAt`). Returns the number of rows updated. Never throws — errors are
 * logged so a transient Mongo blip can't crash the caller's interval.
 *
 * Each expiry is audited (`invitation.expire`, system actor) against the
 * inviting org with the invitation's id, so "what happened to the invite I
 * sent" is answerable from the org's own trail.
 */
export async function sweepExpiredInvitations(): Promise<number> {
  try {
    const filter: QueryFilter<InvitationData> = { status: 'pending', expiresAt: { $lte: new Date() } };
    const lapsed = await Invitation.find(filter)
      .select('_id email organizationId invitedBy')
      .limit(REAP_BATCH)
      .lean();
    if (lapsed.length === 0) return 0;
    const res = await Invitation.updateMany(
      { ...filter, _id: { $in: lapsed.map((i) => i._id) } },
      { $set: { status: 'expired' } },
    );
    const modified = res.modifiedCount ?? 0;
    if (modified > 0) {
      logger.info('Reaped stale pending invitations', { modified });
      for (const inv of lapsed) {
        recordAuditEvent({
          action: 'invitation.expire',
          actorId: SYSTEM_ACTOR_ID,
          orgId: SYSTEM_ORG_ID,
          affectedOrgId: String(inv.organizationId),
          targetType: 'invitation',
          targetId: String(inv._id),
          outcome: 'success',
          details: { email: inv.email, invitedBy: String(inv.invitedBy), reason: 'invitation-reaper' },
        });
      }
    }
    return modified;
  } catch (err) {
    logger.warn('Invitation reaper sweep failed', { error: errorMessage(err) });
    return 0;
  }
}

/** The reaper as a background sweep (see services/background-sweeps.ts). */
export function invitationReaperSweep(intervalMs: number = config.invitation.sweepIntervalMs): IntervalSweepDefinition {
  return {
    name: 'invitation-reaper',
    lockKey: LOCK_KEY,
    intervalMs,
    run: async () => { await sweepExpiredInvitations(); },
    // One idempotent `updateMany` — N replicas converge on the same result, so
    // this may run everywhere when no Redis is configured.
    concurrencySafe: true,
  };
}
