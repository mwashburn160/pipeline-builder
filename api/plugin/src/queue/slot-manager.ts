// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';

import { getDeadLetterQueue } from './plugin-build-dlq.js';
import { getConnectionForDb, getAllTierQueues } from './plugin-build-queue.js';

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
//   PLUGIN_MAX_BUILDS_PER_ORG  max in-flight builds per org (default 3)
//   PLUGIN_ORG_SLOT_DELAY_MS   backoff between re-acquisition tries (default 10s)
//   ORG_SLOT_TTL_SEC           defensive expiry so a crashed worker doesn't leak
const MAX_BUILDS_PER_ORG = parseInt(process.env.PLUGIN_MAX_BUILDS_PER_ORG || '3', 10);
export const ORG_SLOT_DELAY_MS = parseInt(process.env.PLUGIN_ORG_SLOT_DELAY_MS || '10000', 10);
const ORG_SLOT_TTL_SEC = parseInt(process.env.PLUGIN_ORG_SLOT_TTL_SEC || '900', 10);
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
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`;

/** Try to acquire an in-flight build slot for `orgId`. Returns true on success;
 *  false if the org is already at its cap (caller should re-enqueue). Records
 *  `jobId -> orgId` so the scrubber can reclaim a slot whose job vanished. */
export async function tryAcquireOrgSlot(orgId: string, jobId: string): Promise<boolean> {
  const redis = getConnectionForDb(0);
  const result = await redis.eval(
    ACQUIRE_SLOT_LUA, 1, orgSlotKey(orgId),
    String(MAX_BUILDS_PER_ORG), String(ORG_SLOT_TTL_SEC),
  );
  if (result !== 1) return false;
  await redis.hset(orgSlotOwnersKey, jobId, orgId);
  return true;
}

/** Release the org's slot. Defensive: never let the counter go negative. */
export async function releaseOrgSlot(orgId: string, jobId: string): Promise<void> {
  const redis = getConnectionForDb(0);
  const count = await redis.decr(orgSlotKey(orgId));
  if (count < 0) await redis.set(orgSlotKey(orgId), '0', 'EX', ORG_SLOT_TTL_SEC);
  await redis.hdel(orgSlotOwnersKey, jobId);
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
    const tierJobLists = await Promise.all([
      ...getAllTierQueues().map(({ queue }) => queue.getJobs([...activeStates])),
      getDeadLetterQueue().getJobs([...activeStates]),
    ]);
    const liveJobIds = new Set<string>();
    for (const jobs of tierJobLists) for (const j of jobs) if (j.id) liveJobIds.add(String(j.id));

    for (const [jobId, orgId] of ownerEntries) {
      if (liveJobIds.has(jobId)) continue;
      const count = await redis.decr(orgSlotKey(orgId));
      if (count < 0) await redis.set(orgSlotKey(orgId), '0', 'EX', ORG_SLOT_TTL_SEC);
      await redis.hdel(orgSlotOwnersKey, jobId);
      logger.warn('Reclaimed leaked org build slot', { jobId, orgId });
    }
  } catch (err) {
    logger.debug('Org slot scrub failed', { error: errorMessage(err) });
  }
}
