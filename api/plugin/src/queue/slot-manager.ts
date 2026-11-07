// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BUILD_CLASSES, buildSlotsFor, envInt, createLogger, errorMessage, isSystemOrgId } from '@pipeline-builder/api-core';
import type { BuildClass, QuotaTier } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';

import { getAllTierQueues, getBuildCfg, getConnectionForDb, getDeadLetterQueue } from './connections.js';

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
//   PLUGIN_MAX_BUILDS_<TIER>_<CLASS> max in-flight builds per org, per class
//   PLUGIN_ORG_SLOT_DELAY_MS backoff between re-acquisition tries (default 10s)
//   ORG_SLOT_TTL_SEC defensive expiry so a crashed worker doesn't leak

/**
 * The per-org cap, read per (tier, class) cell.
 *
 * ONE FLAT FIGURE BEFORE, and it gave a Developer org the same three in-flight
 * builds as an Enterprise one — the per-org semaphore was the one place in the
 * build path that ignored what the tenant pays for. The ladder lives in the
 * build catalog (`BUILD_CLASS_CATALOG[class].slotsByTier`), beside the labels
 * and size floors it has to stay coherent with, and each cell takes its own
 * override. The catalog holds DEFAULTS only — it is browser-importable, so it
 * cannot read an env var, and this function is where the overlay happens.
 *
 * NaN-guarded env parse, which is not cosmetic: `String(NaN)` makes the acquire
 * Lua's `tonumber(ARGV[1])` return nil, so a single garbage override would make
 * every `tryAcquireOrgSlot` throw and brick ALL plugin builds — not just the
 * tier whose variable was fat-fingered.
 *
 * The PER-CLASS BASELINE (`pluginBuild.orgBuildSlots`,
 * `PLUGIN_ORG_BUILD_SLOTS_STANDARD` 5 / `_FLEXIBLE` 8) is what every org gets;
 * the catalog ladder only ever RAISES it, so the default here is
 * `max(baseline[class], ladder)`. The ladder's lower rows were too tight for a
 * real working set — at three in flight an org pushing a batch spends most of
 * its time queued, and past `PLUGIN_ORG_SLOT_MAX_WAIT_MS` those waiting builds
 * fail TERMINALLY rather than merely late.
 *
 * Per CLASS because one shared figure flattened the two: with a single baseline
 * of 5, developer/pro/team got 5 for standard AND flexible, so the cheap class
 * bought a later start and no extra slots. Flexible's higher baseline keeps
 * "flexible has more headroom" true on every tier.
 *
 * The ORDER is the contract: the baseline moves the DEFAULT, and an explicit
 * `PLUGIN_MAX_BUILDS_<TIER>_<CLASS>` still wins outright — including a value
 * below the baseline. An operator who deliberately wants one tier at a single
 * build keeps that; the baseline only moves the figure nobody set.
 */
export function maxBuildsPerOrg(tier: QuotaTier, buildClass: BuildClass): number {
  return envInt(
    `PLUGIN_MAX_BUILDS_${tier.toUpperCase()}_${buildClass.toUpperCase()}`,
    Math.max(getBuildCfg().orgBuildSlots[buildClass], buildSlotsFor(tier, buildClass)),
    { min: 1 },
  );
}

/**
 * Orgs the per-org semaphore does not apply to.
 *
 * ONLY the system org, and it is not a convenience: the cap is a MULTI-TENANCY
 * FAIRNESS device between paying tenants, and the system org is not a tenant.
 * It is where the sample plugin catalogue loads, so a fresh install enqueues the
 * whole catalogue at once under this one org — and a cap of three to eight
 * in-flight builds against a hundred-odd queued ones means everything past the
 * first few waits out `PLUGIN_ORG_SLOT_MAX_WAIT_MS` and fails TERMINALLY. The
 * install then reports success (it counts HTTP 202s) while most of the catalogue
 * is missing.
 *
 * Exactly the line `buildSpendsCredits` already draws for build credits, for the
 * same stated reason — platform work done on the tenant's behalf rather than
 * work the tenant asked for. The slot cap was added later and did not inherit
 * the carve-out.
 *
 * WHAT THE CARVE-OUT IS, AND IS NOT. The system org is exempt from the WAIT
 * BECOMING TERMINAL, not from the cap. Those two were one flag, and collapsing
 * them cost an install each way round:
 *
 *  - Capped AND failing on the wait: a 119-plugin catalogue queued behind a cap
 *    of 3 waited out `PLUGIN_ORG_SLOT_MAX_WAIT_MS` and 80 builds failed for
 *    good. Queueing was correct; dying was not.
 *  - Exempt from both: nothing bounded the fan-out of the one org that loads the
 *    whole catalogue, so 8 replicas x 4 concurrency put 32 builds in flight and
 *    OOMKilled the image registry, taking 107 of 117 plugins with it.
 *
 * So the system org now holds a real slot from a real counter — finite,
 * `PLUGIN_SYSTEM_ORG_MAX_BUILDS` — and a system-org build that cannot get one is
 * re-delayed for as long as it takes instead of failing. The owner-hash growth
 * that argued against a "very large cap" is bounded by the cap itself.
 *
 * WHETHER 12 BINDS depends on borrowing, and it used to be able to say it never
 * did. At the shipped concurrency the fleet ceiling for this tier is 1 build per
 * replica (`unlimited`'s ladder row) times the replica count — 8 on eks — so 12
 * sat above it and the per-TIER limit was always the one that bound. Raising
 * `PLUGIN_BUILD_BORROW_MAX` lifts that ceiling to (1 + borrow) per replica, and
 * from borrow >= 1 on a scaled eks fleet it exceeds 12 — so THIS cap becomes the
 * binding constraint on a catalogue load. That is the right place for the limit
 * to sit, but it means an operator who enables borrowing to speed up a first-run
 * install has to raise this too, or stop at 12.
 */
export function systemOrgSlotCap(): number {
  return envInt('PLUGIN_SYSTEM_ORG_MAX_BUILDS', 12, { min: 1 });
}

/**
 * Whether `orgId` may wait for a slot indefinitely rather than failing at
 * {@link ORG_SLOT_WAIT_BUDGET_MS}. True for the system org only: a catalogue load is
 * platform work, and a plugin that is merely LATE must not read as a plugin that
 * is broken.
 */
export function orgSlotWaitExempt(orgId: string): boolean {
  return isSystemOrgId(orgId);
}

export const ORG_SLOT_DELAY_MS = envInt('PLUGIN_ORG_SLOT_DELAY_MS', 10000, { min: 1 });
const ORG_SLOT_TTL_SEC = envInt('PLUGIN_ORG_SLOT_TTL_SEC', 900, { min: 1 });

/**
 * How often a RUNNING build refreshes its slot's TTL, derived from the TTL so
 * the two cannot drift.
 *
 * The TTL is a CRASH-RECOVERY window, not a build-duration cap — the same
 * distinction the leader lock already makes, where the TTL covers a dead holder
 * and a heartbeat covers a long run. Without the heartbeat the TTL doubled as a
 * duration cap: `EXPIRE` is refreshed on every GRANTED acquire (it used to be
 * refreshed on every attempt, denials included — see ACQUIRE_SLOT_LUA for why
 * that defeated crash recovery), so an org with builds in flight and no further
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
/**
 * Longest a denied build waits between re-tries. The interval BACKS OFF —
 * `ORG_SLOT_DELAY_MS` doubling up to this — because a fixed 10s poll is pure
 * waste once an org is parked at its cap: with 569 jobs waiting that is ~57
 * Redis acquire attempts a second, every one of which is known to fail, and the
 * builds they are waiting on take minutes. At 60s the churn drops ~6x and the
 * worst case is a minute of extra latency on a job already waiting an hour.
 */
const ORG_SLOT_MAX_DELAY_MS = envInt('PLUGIN_ORG_SLOT_MAX_DELAY_MS', 60_000, { min: 1 });

/**
 * How long to wait before the next slot attempt, given how many have failed.
 *
 * Doubles from `ORG_SLOT_DELAY_MS`, capped. The first wait stays short so the
 * common case — a slot freeing within seconds — is still quick.
 */
export function orgSlotRetryDelayMs(attempt: number): number {
  const exp = ORG_SLOT_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, ORG_SLOT_MAX_DELAY_MS);
}

/**
 * The wait budget, as ELAPSED TIME rather than a count of denials.
 *
 * It used to be `ORG_SLOT_MAX_WAIT_MS / ORG_SLOT_DELAY_MS` — 180 attempts — which
 * only equals 30 minutes while every interval is exactly 10s. With a backoff the
 * same 180 attempts span hours, so the budget has to measure the clock. It is
 * also what the refusal message always claimed to report.
 */
export const ORG_SLOT_WAIT_BUDGET_MS = ORG_SLOT_MAX_WAIT_MS;

/**
 * Reconciliation interval for {@link scrubOrgSlots}. Its OWN interval: it used
 * to piggy-back the temp-dir cleanup tick, which runs at `TEMP_DIR_MAX_AGE_MS`
 * (four hours) — a max AGE borrowed as a period, and sixteen times the slot TTL,
 * so in steady state the TTL was the de-facto reclaimer and the scrub was the
 * backstop rather than the other way round. Defaults to the heartbeat interval.
 */
export const ORG_SLOT_SCRUB_MS = envInt('PLUGIN_ORG_SLOT_SCRUB_MS', ORG_SLOT_HEARTBEAT_MS, { min: 1_000 });
/**
 * One counter PER CLASS, so the two classes cannot eat each other's headroom.
 *
 * A shared counter would make `flexible` a way to starve `standard`: an org that
 * filled a single counter with ten cheap flexible builds would have no slot left
 * for the urgent fix the standard class exists to carry, which is the whole
 * reason every tier has both classes.
 */
const orgSlotKey = (orgId: string, buildClass: BuildClass) => `pb:org-build:${orgId}:${buildClass}`;

/** Sibling hash `queueName:jobId -> orgId|class` for live slot owners. The
 *  scrubber walks this to reconcile slots that BullMQ no longer knows about.
 *
 *  The value carries the CLASS as well as the org because release decrements a
 *  class-specific counter: with the org alone the scrubber could not tell which
 *  of the two counters a vanished job had taken, and reclaiming from the wrong
 *  one both leaks the real slot and drives the other counter toward its
 *  negative clamp. Split on the LAST separator so an org id containing one
 *  still parses. */
const orgSlotOwnersKey = 'pb:org-build-owners';
const ownerValue = (orgId: string, buildClass: BuildClass) => `${orgId}|${buildClass}`;

function parseOwnerValue(value: string): { orgId: string; buildClass: BuildClass } {
  const at = value.lastIndexOf('|');
  if (at < 0) return { orgId: value, buildClass: 'standard' };
  const cls = value.slice(at + 1);
  return {
    orgId: value.slice(0, at),
    // An unrecognised suffix is treated as part of the org id rather than
    // trusted as a class: a bad parse must not decrement a counter that was
    // never incremented.
    buildClass: (BUILD_CLASSES as readonly string[]).includes(cls) ? (cls as BuildClass) : 'standard',
  };
}

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
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  -- NO EXPIRE on the denied path, and the order here is the whole point.
  --
  -- The EXPIRE used to precede this check, so a DENIED attempt refreshed the
  -- counter's TTL. That TTL is the CRASH-RECOVERY window (a dead worker's slot
  -- expires and the org recovers) — and an org at its cap is retrying every
  -- ORG_SLOT_DELAY_MS, so those denials kept resetting the window. A single
  -- leaked slot therefore became PERMANENT: crash recovery could never fire
  -- while the starved jobs it was starving kept pushing it back, and only the
  -- scrubber could break the cycle. The busier the org, the less likely the
  -- recovery.
  --
  -- A denied attempt holds nothing, so it has no TTL of its own to protect, and
  -- the slots that ARE held are kept alive by their own heartbeats
  -- (REFRESH_SLOT_LUA) rather than by other jobs' failed attempts.
  return 0
end
-- Refreshed on a GRANT, which is what the original intent was: a
-- continuously-busy org's key must not expire mid-flight while slots are held.
-- The heartbeat covers a long-running hold; this covers the gap between one
-- build finishing and the next starting.
redis.call('EXPIRE', KEYS[1], ARGV[2])
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

export async function refreshOrgSlot(orgId: string, jobId: string, buildClass: BuildClass): Promise<boolean> {
  const redis = getConnectionForDb(0);
  const result = await redis.eval(
    REFRESH_SLOT_LUA, 2, orgSlotKey(orgId, buildClass), orgSlotOwnersKey, jobId, String(ORG_SLOT_TTL_SEC),
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
export function startOrgSlotHeartbeat(orgId: string, jobId: string, buildClass: BuildClass): () => void {
  const timer = setInterval(() => {
    void refreshOrgSlot(orgId, jobId, buildClass)
      .then((extended) => {
        if (!extended) logger.debug('Slot heartbeat found no owner record; build likely released', { orgId, jobId });
      })
      .catch((err) => logger.debug('Slot heartbeat failed', { orgId, jobId, error: errorMessage(err) }));
  }, ORG_SLOT_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Try to acquire an in-flight build slot for `orgId` in `buildClass`. Returns
 *  true on success; false if the org is already at that class's cap for its tier
 *  (caller should re-enqueue). Records `jobId -> orgId|class` so the scrubber
 *  can reclaim a slot whose job vanished, from the right counter. */
export async function tryAcquireOrgSlot(
  orgId: string, jobId: string, tier: QuotaTier, buildClass: BuildClass,
): Promise<boolean> {
  const redis = getConnectionForDb(0);
  // TWO keys: the class counter and the owner hash — the owner record is written
  // atomically with the INCR (see ACQUIRE_SLOT_LUA).
  const result = await redis.eval(
    ACQUIRE_SLOT_LUA, 2, orgSlotKey(orgId, buildClass), orgSlotOwnersKey,
    String(isSystemOrgId(orgId) ? systemOrgSlotCap() : maxBuildsPerOrg(tier, buildClass)),
    String(ORG_SLOT_TTL_SEC), jobId, ownerValue(orgId, buildClass),
  );
  return result === 1;
}

/** Release `jobId`'s slot for `orgId`. Idempotent per job (see RELEASE_SLOT_LUA);
 *  resolves true when this call gave a held slot back. */
export async function releaseOrgSlot(orgId: string, jobId: string, buildClass: BuildClass): Promise<boolean> {
  const redis = getConnectionForDb(0);
  const released = await redis.eval(
    RELEASE_SLOT_LUA, 2, orgSlotKey(orgId, buildClass), orgSlotOwnersKey, jobId, String(ORG_SLOT_TTL_SEC),
  );
  return released === 1;
}

/**
 * The live slot state, per (org, class): how many slots the owner hash says are
 * HELD, and what the counter the cap is compared against actually says.
 *
 * **The two can disagree, and that disagreement is the whole point.** The
 * counter is what `ACQUIRE_SLOT_LUA` compares the cap against; the owner hash is
 * the record of who holds what. A counter ABOVE its owners is a leaked slot —
 * capacity that has silently gone missing and will keep refusing builds until
 * something reclaims it. Neither number was visible anywhere before: the only
 * symptom was a build failing after thirty minutes with "this organization is at
 * its limit", and working out why meant archaeology over logs.
 *
 * Derived from ONE `HGETALL` of the owner hash plus one read per group, so it is
 * cheap enough for a scrape interval. Deliberately no `SCAN` of the keyspace:
 * the owner hash already enumerates every slot, and scanning `pb:org-build:*`
 * would also pick up counters whose owners are gone and report them as live.
 */
export interface OrgSlotState {
  orgId: string;
  buildClass: BuildClass;
  /** Owner records — the jobs that actually hold a slot. */
  held: number;
  /** The counter the cap is compared against. */
  counted: number;
  /** `counted - held`, floored at 0. Positive means leaked capacity. */
  leaked: number;
}

export async function orgSlotSnapshot(): Promise<OrgSlotState[]> {
  const redis = getConnectionForDb(0);
  const owners = await redis.hgetall(orgSlotOwnersKey);

  const held = new Map<string, { orgId: string; buildClass: BuildClass; held: number }>();
  for (const value of Object.values(owners)) {
    const { orgId, buildClass } = parseOwnerValue(value);
    const key = ownerValue(orgId, buildClass);
    const seen = held.get(key);
    if (seen) seen.held += 1;
    else held.set(key, { orgId, buildClass, held: 1 });
  }

  const rows = [...held.values()];
  if (rows.length === 0) return [];
  const counts = await Promise.all(
    rows.map(async (r) => Number(await redis.get(orgSlotKey(r.orgId, r.buildClass))) || 0),
  );
  return rows.map((r, i) => ({ ...r, counted: counts[i]!, leaked: Math.max(0, counts[i]! - r.held) }));
}

/**
 * Is this org's cap held by LIVE builds, rather than by leaked counters?
 *
 * The distinction decides whether a denied job's wait counts toward
 * {@link ORG_SLOT_WAIT_BUDGET_MS}. An org at its own cap with every slot backed by a
 * running build is not starving — it is queueing behind its own work, and a slot
 * frees the moment one of those builds finishes. An org whose counter sits at the
 * cap with NO live owners is stuck: the counter leaked (a worker died between
 * INCR and the owner record's TTL) and no amount of waiting will clear it before
 * the scrubber runs, so the deadline is exactly right there.
 *
 * NOTE on the obvious shortcut: "does the org have builds running" cannot be
 * answered with `counter > 0`. A denial means the INCR exceeded the cap, so the
 * counter is ALWAYS at least the cap at that moment — gating on it would disable
 * the deadline entirely rather than narrowing it.
 */
export async function orgSlotsBackedByLiveBuilds(orgId: string, buildClass: BuildClass): Promise<boolean> {
  const redis = getConnectionForDb(0);
  const [owners, counted] = await Promise.all([
    redis.hgetall(orgSlotOwnersKey),
    redis.get(orgSlotKey(orgId, buildClass)).then((v) => Number(v) || 0),
  ]);
  if (counted <= 0) return false;
  const mine = ownerValue(orgId, buildClass);
  const held = Object.values(owners).filter((v) => v === mine).length;
  // Every counted slot accounted for by a live owner record: busy, not stuck.
  return held >= counted;
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

    for (const [jobId, owner] of ownerEntries) {
      if (liveJobIds.has(jobId)) continue;
      const { orgId, buildClass } = parseOwnerValue(owner);
      // Same idempotent release as the processor: if the job released its own
      // slot after the snapshot above, this is a no-op rather than a second DECR.
      if (await releaseOrgSlot(orgId, jobId, buildClass)) {
        // Counted, not just logged: a leaked slot PERMANENTLY reduces that org's
        // build concurrency until a scrub reclaims it, so capacity shrinks
        // silently. The log line names the job; the counter is what an alert can
        // see.
        incCounter('plugin_build_slot_reclaimed_total', { build_class: buildClass });
        logger.warn('Reclaimed leaked org build slot', { jobId, orgId, buildClass });
      }
    }
  } catch (err) {
    logger.debug('Org slot scrub failed', { error: errorMessage(err) });
  }
}
