// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt, createLogger, errorMessage } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';

import { getAllTierQueues, getConnectionForDb, getDeadLetterQueue } from './connections.js';

const logger = createLogger('plugin-build-queue');

// ---------------------------------------------------------------------------
// Per-org concurrency cap (multi-tenancy hardening)
// ---------------------------------------------------------------------------
//
// BullMQ OSS doesn't have built-in group-keyed concurrency; we layer a
// per-org semaphore on top of Redis. Each worker tries to acquire a slot
// before processing; over the cap it re-enqueues with a short delay so
// another org's job can take the worker slot. Atomic via Lua so two
// concurrent acquires can't both observe a stale count and over-allocate.
//
// Tuning:
//   PLUGIN_MAX_BUILDS_PER_ORG max in-flight builds per org (default 3)
//   PLUGIN_ORG_SLOT_DELAY_MS backoff between re-acquisition tries (default 10s)
//   ORG_SLOT_TTL_SEC defensive expiry so a crashed worker doesn't leak
// NaN-guarded env parse: a garbage PLUGIN_MAX_BUILDS_PER_ORG must fall back to
// the default, never `NaN`. `String(NaN)` -> the acquire Lua's
// `tonumber(ARGV[1])` returns nil, so every tryAcquireOrgSlot would throw and
// brick ALL plugin builds.
export const MAX_BUILDS_PER_ORG = envInt('PLUGIN_MAX_BUILDS_PER_ORG', 3, { min: 1 });
export const ORG_SLOT_DELAY_MS = envInt('PLUGIN_ORG_SLOT_DELAY_MS', 10000, { min: 1 });
const ORG_SLOT_TTL_SEC = envInt('PLUGIN_ORG_SLOT_TTL_SEC', 900, { min: 1 });

/**
 * How often a RUNNING build refreshes its slot's TTL, derived from the TTL so
 * the two cannot drift.
 *
 * The TTL is a CRASH-RECOVERY window, not a build-duration cap — the same
 * distinction the leader lock already makes, where the TTL covers a dead holder
 * and a heartbeat covers a long run. Without the heartbeat the TTL doubled as a
 * duration cap: `EXPIRE` is refreshed on every acquire ATTEMPT (it precedes the
 * cap check in ACQUIRE_SLOT_LUA), so an org with builds in flight and no further
 * attempts for ORG_SLOT_TTL_SEC lost its counter WHILE those builds ran. The
 * next acquire then started from zero and the per-org cap could be exceeded by
 * however many were in flight, with release afterwards under-counting into the
 * negative clamp. At a 900s TTL that fires for any build over fifteen minutes,
 * which is the ordinary case rather than the exceptional one.
 */
const ORG_SLOT_HEARTBEAT_MS = Math.max(1_000, Math.floor((ORG_SLOT_TTL_SEC * 1000) / 3));

/**
 * How long a job may wait for a slot before failing TERMINALLY, expressed as a
 * delay budget. A slot delay spends no BullMQ attempt, so this is the only thing
 * standing between a starved job and an endless silent bounce.
 */
const ORG_SLOT_MAX_WAIT_MS = envInt('PLUGIN_ORG_SLOT_MAX_WAIT_MS', 1_800_000, { min: 1 });
export const MAX_SLOT_DELAYS = Math.max(1, Math.floor(ORG_SLOT_MAX_WAIT_MS / ORG_SLOT_DELAY_MS));

/**
 * Reconciliation interval for {@link scrubOrgSlots}. Its OWN interval: it used
 * to piggy-back the temp-dir cleanup tick, which runs at `TEMP_DIR_MAX_AGE_MS`
 * (four hours) — a max AGE borrowed as a period, and sixteen times the slot TTL,
 * so in steady state the TTL was the de-facto reclaimer and the scrub was the
 * backstop rather than the other way round. Defaults to the heartbeat interval.
 */
export const ORG_SLOT_SCRUB_MS = envInt('PLUGIN_ORG_SLOT_SCRUB_MS', ORG_SLOT_HEARTBEAT_MS, { min: 1_000 });
const orgSlotKey = (orgId: string) => `pb:org-build:${orgId}`;
/** Sibling hash `jobId -> orgId` for live slot owners. The scrubber walks
 *  this to reconcile slots that BullMQ no longer knows about. */
const orgSlotOwnersKey = 'pb:org-build-owners';

/**
 * Atomic check-and-increment via Lua. Returns 1 if a slot was reserved
 * (count <= cap), 0 if the cap was already reached. Avoids the INCR-then-DECR
 * race where two acquires can briefly observe a count over the cap before one
 * rolls back.
 */
const ACQUIRE_SLOT_LUA = `
-- Re-entrant per job: a job that already owns a slot (a stalled job re-run by
-- BullMQ under the same id) must not take a second one — release is keyed on
-- the owner record, so a second INCR could never be given back.
if redis.call('HEXISTS', KEYS[2], ARGV[3]) == 1 then
  return 1
end
local count = redis.call('INCR', KEYS[1])
-- Refresh the TTL on EVERY acquire, not just the 0->1 transition. Setting it
-- only once meant a continuously-busy org's key could expire mid-flight
-- (between acquires) while slots were still held, letting the counter reset
-- and the cap be exceeded. Unconditional EXPIRE keeps the key alive as long as
-- the org keeps building.
redis.call('EXPIRE', KEYS[1], ARGV[2])
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
-- Record the owner IN THE SAME script as the INCR. These used to be two round
-- trips: if the HSET threw, the counter was already raised with NO owner entry,
-- and since the scrubber reclaims by iterating the owner hash it could never
-- reclaim that slot — only the 900s TTL would, after wedging the org's cap.
redis.call('HSET', KEYS[2], ARGV[3], ARGV[4])
return 1
`;

/**
 * Atomic, IDEMPOTENT release: the counter is decremented only when THIS call
 * removed the job's owner record. The processor's `finally` and the scrubber
 * can both try to release the same job (the scrubber snapshots the owner hash,
 * then the job finishes and releases before the scrubber reaches it); gating the
 * DECR on the HDEL means only one of them gives the slot back. Never lets the
 * counter go negative. Returns 1 when a slot was released, 0 when it was not held.
 */
const RELEASE_SLOT_LUA = `
if redis.call('HDEL', KEYS[2], ARGV[1]) == 0 then
  return 0
end
local count = redis.call('DECR', KEYS[1])
if count < 0 then
  redis.call('SET', KEYS[1], '0', 'EX', ARGV[2])
end
return 1
`;

/**
 * Refresh a HELD slot's TTL, gated on this job still owning it. The ownership
 * check matters: a heartbeat timer that outlived its job (a release raced with
 * the tick) must not resurrect the org's counter key and wedge a slot the
 * scrubber would then have to reclaim. Returns true when the TTL was extended.
 */
const REFRESH_SLOT_LUA = `
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then
  return 0
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

export async function refreshOrgSlot(orgId: string, jobId: string): Promise<boolean> {
  const redis = getConnectionForDb(0);
  const result = await redis.eval(
    REFRESH_SLOT_LUA, 2, orgSlotKey(orgId), orgSlotOwnersKey, jobId, String(ORG_SLOT_TTL_SEC),
  );
  return result === 1;
}

/**
 * Keep `jobId`'s slot alive for as long as its build runs. Returns the stopper,
 * which the caller MUST invoke in a `finally` beside the release.
 *
 * Best-effort by construction: a failed refresh is logged at debug and nothing
 * else, because losing a TTL extension costs a reclaimable slot whereas throwing
 * here would cost a build that may already have published its image.
 */
export function startOrgSlotHeartbeat(orgId: string, jobId: string): () => void {
  const timer = setInterval(() => {
    void refreshOrgSlot(orgId, jobId)
      .then((extended) => {
        if (!extended) logger.debug('Slot heartbeat found no owner record; build likely released', { orgId, jobId });
      })
      .catch((err) => logger.debug('Slot heartbeat failed', { orgId, jobId, error: errorMessage(err) }));
  }, ORG_SLOT_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Try to acquire an in-flight build slot for `orgId`. Returns true on success;
 *  false if the org is already at its cap (caller should re-enqueue). Records
 *  `jobId -> orgId` so the scrubber can reclaim a slot whose job vanished. */
export async function tryAcquireOrgSlot(orgId: string, jobId: string): Promise<boolean> {
  const redis = getConnectionForDb(0);
  // TWO keys: the org counter and the owner hash — the owner record is written
  // atomically with the INCR (see ACQUIRE_SLOT_LUA).
  const result = await redis.eval(
    ACQUIRE_SLOT_LUA, 2, orgSlotKey(orgId), orgSlotOwnersKey,
    String(MAX_BUILDS_PER_ORG), String(ORG_SLOT_TTL_SEC), jobId, orgId,
  );
  return result === 1;
}

/** Release `jobId`'s slot for `orgId`. Idempotent per job (see RELEASE_SLOT_LUA);
 *  resolves true when this call gave a held slot back. */
export async function releaseOrgSlot(orgId: string, jobId: string): Promise<boolean> {
  const redis = getConnectionForDb(0);
  const released = await redis.eval(
    RELEASE_SLOT_LUA, 2, orgSlotKey(orgId), orgSlotOwnersKey, jobId, String(ORG_SLOT_TTL_SEC),
  );
  return released === 1;
}

/**
 * Reconcile slot counters against live BullMQ state. For each owner entry
 * whose jobId is no longer in any active/waiting/delayed set across the tier
 * queues and DLQ, decrement the org's counter and drop the owner record.
 * Protects against worker crashes that leak slots until TTL expiry.
 */
export async function scrubOrgSlots(): Promise<void> {
  const redis = getConnectionForDb(0);
  try {
    const owners = await redis.hgetall(orgSlotOwnersKey);
    const ownerEntries = Object.entries(owners);
    if (ownerEntries.length === 0) return;

    const activeStates = ['active', 'waiting', 'delayed'] as const;
    // Qualify each live job id by its queue name. BullMQ job ids are
    // per-queue-monotonic, so the four per-tier queues (+ DLQ) mint colliding
    // bare ids; a bare-id set would treat a job in one queue as "live" for a
    // same-id owner recorded from another queue, defeating the scrub. The owner
    // hash is keyed `${queueName}:${jobId}` (see the processor), so match that.
    const queues = [...getAllTierQueues().map(({ queue }) => queue), getDeadLetterQueue()];
    const jobLists = await Promise.all(queues.map((q) => q.getJobs([...activeStates])));
    const liveJobIds = new Set<string>();
    queues.forEach((q, i) => {
      for (const j of jobLists[i]) if (j.id) liveJobIds.add(`${q.name}:${j.id}`);
    });

    for (const [jobId, orgId] of ownerEntries) {
      if (liveJobIds.has(jobId)) continue;
      // Same idempotent release as the processor: if the job released its own
      // slot after the snapshot above, this is a no-op rather than a second DECR.
      if (await releaseOrgSlot(orgId, jobId)) {
        // Counted, not just logged: a leaked slot PERMANENTLY reduces that org's
        // build concurrency until a scrub reclaims it, so capacity shrinks
        // silently. The log line names the job; the counter is what an alert can
        // see.
        incCounter('plugin_build_slot_reclaimed_total', {});
        logger.warn('Reclaimed leaked org build slot', { jobId, orgId });
      }
    }
  } catch (err) {
    logger.debug('Org slot scrub failed', { error: errorMessage(err) });
  }
}
