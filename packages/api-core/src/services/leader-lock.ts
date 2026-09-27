// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { createEnvRedisClient, whenRedisReady, type ReadyAwareRedis } from './env-redis.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';

const lockLogger = createLogger('leader-lock');

/**
 * Minimal Redis client surface needed for a leader lock (a subset of ioredis).
 * `set` is variadic so callers can pass `'PX', ttl, 'NX'`.
 */
export interface LockRedis extends ReadyAwareRedis {
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  /** Optional Lua eval (ioredis has it). When present, release uses an atomic
   *  compare-and-delete so a lapsed holder can't free a successor's lock. */
  eval?(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>;
  /** Graceful close (ioredis `quit`) — called on shutdown so the connection
   *  doesn't keep the event loop alive. */
  quit?(): Promise<unknown>;
  /** Immediate close (ioredis `disconnect`) — the fallback if `quit` fails. */
  disconnect?(): void;
}

/**
 * Best-effort close of a leader-lock Redis client on shutdown. Prefers graceful
 * `quit`; falls back to `disconnect`. No-op for a null client / one without
 * either method. Never throws.
 */
export async function closeLeaderLock(redis: LockRedis | null | undefined): Promise<void> {
  if (!redis) return;
  try {
    if (typeof redis.quit === 'function') { await redis.quit(); return; }
  } catch {
    // fall through to disconnect
  }
  try { redis.disconnect?.(); } catch { /* best-effort */ }
}

/** Atomic "delete only if I still own it" — closes the get-then-del race where
 *  the lock expires and is re-acquired between the two calls. */
const RELEASE_IF_OWNER =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** Atomic "extend only if I still own it" — the heartbeat. */
const EXTEND_IF_OWNER =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

/** Longest a run waits for a not-yet-connected client before skipping the window. */
const LOCK_READY_TIMEOUT_MS = 10_000;

/**
 * Default lock lifetime — a CRASH-RECOVERY window, not a run-duration cover.
 *
 * The holder heartbeats (compare-and-PEXPIRE every `ttlMs / 3`) for as long as
 * `fn` runs, so a six-hour job holds a two-minute lock perfectly well. What the
 * TTL actually decides is how long a job stays BLOCKED after the pod holding it
 * dies without releasing — the key simply sits there until it expires. Sizing the
 * TTL to the expected run time (which is what several callers used to do) turned a
 * crashed pod into hours of silent inactivity.
 *
 * Two minutes leaves three missed heartbeats of slack, so an event-loop stall or a
 * brief Redis blip does not hand the lock to a second pod mid-run, while recovery
 * after a real crash is bounded at two minutes.
 */
export const DEFAULT_LEADER_LOCK_TTL_MS = 120_000;

/**
 * The one way to build a leader-lock key: `<service>:<job>:leader`.
 *
 * Four conventions had grown up — `plugin:vuln-rescan:leader`,
 * `platform:leader:org-purge`, a bare `ecosystem-stats:leader`, and billing's
 * unnamespaced `subscription-lifecycle` — which meant no single glob found every
 * lock. `KEYS '*:leader'` missed billing's three entirely, so an operator asking
 * "what is held right now" got a partial answer. The env Redis client sets no
 * `keyPrefix`, so these share one flat keyspace with cache, BullMQ and spool keys;
 * the `<service>:` segment is what keeps them apart.
 */
export function leaderLockKey(service: string, job: string): string {
  return `${service}:${job}:leader`;
}

/** Why a leader-locked run was told to stop. */
export type LeaderLockAbortReason = 'lock-lost' | 'shutdown';

/** What a leader-locked run is told while it runs. */
export interface LeaderLockRun {
  /**
   * Aborted when the lock is LOST mid-run (a heartbeat found another holder, or
   * the key gone), or when the caller is SHUTTING DOWN. Long runs must check it
   * between units of work and return: past a lock loss another pod may be doing
   * the same work, and on shutdown returning promptly is what releases the lock
   * instead of leaving it to expire.
   *
   * `signal.reason` is a {@link LeaderLockAbortReason}.
   */
  signal: AbortSignal;
}

/** Caller-supplied controls for {@link withLeaderLock}. */
export interface LeaderLockOptions {
  /**
   * Aborted by the caller to ask a running job to stop — a scheduler's `stop()`
   * on shutdown. Merged into {@link LeaderLockRun.signal}, so a signal-aware `fn`
   * returns and the lock is released in the `finally` rather than lingering for
   * the rest of the TTL.
   */
  signal?: AbortSignal;
}

/**
 * Run `fn` only if this process wins a short-lived distributed lock — the
 * across-pods "single runner" guard for periodic jobs (digest flushes, etc.).
 *
 * Uses `SET key token NX PX ttl`, so exactly one holder runs per window and the
 * lock auto-expires if that holder dies mid-run (no stuck lock). While `fn`
 * runs, the holder HEARTBEATS (compare-and-PEXPIRE every `ttlMs / 3`), so a run
 * that outlasts `ttlMs` keeps the lock instead of silently letting a second pod
 * start the same work; a heartbeat that finds the lock gone aborts
 * `run.signal`. The lock is released on completion, but only if we still own
 * it — a slower predecessor never deletes a successor's lock.
 *
 * If Redis can't be reached the run is skipped (returns false) rather than
 * rejecting — callers are timers, and a Redis blip must not crash the process.
 *
 * EVERY outcome is counted, because they mean very different things and the
 * difference used to be visible only in a log line:
 *  - `leader_lock_acquired_total` — this pod ran the window. A job whose count
 *    stays flat is not running ANYWHERE, which is the condition worth alerting on.
 *  - `leader_lock_contended_total` — another pod holds it. Healthy and expected
 *    with replicas > 1; exactly one acquire per window across the fleet.
 *  - `leader_lock_unavailable_total` — Redis unreachable, so NOBODY ran this
 *    window. A Redis blip silently stopping every sweep fleet-wide was previously
 *    a WARN log and nothing else.
 *
 * @returns true if we held the lock and ran `fn`; false if another holder did or
 *   the lock couldn't be taken.
 */
export async function withLeaderLock(
  redis: LockRedis,
  key: string,
  ttlMs: number,
  fn: (run: LeaderLockRun) => Promise<void>,
  opts: LeaderLockOptions = {},
): Promise<boolean> {
  // Asked to stop before we even tried: don't take a lock we are about to drop.
  if (opts.signal?.aborted) return false;

  const token = randomUUID();
  let acquired: unknown;
  try {
    // The env client has no offline queue: a SET before the first connection
    // completes is rejected, which made the FIRST tick after every boot a
    // guaranteed skip. Wait (bounded) for readiness first.
    await whenRedisReady(redis, Math.min(LOCK_READY_TIMEOUT_MS, Math.max(1, ttlMs)));
    acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  } catch (err) {
    // Redis unreachable (including before the first connection completes): no
    // pod can prove it's the leader, so nobody runs this window. Skipping is
    // the safe side — running here could duplicate destructive work across pods.
    lockLogger.warn('Leader lock unavailable; skipping this run', {
      key, error: errorMessage(err),
    });
    emitCounter('leader_lock_unavailable_total', { key });
    return false;
  }
  if (acquired !== 'OK') {
    emitCounter('leader_lock_contended_total', { key });
    return false;
  }
  emitCounter('leader_lock_acquired_total', { key });

  const lost = new AbortController();
  // Shutdown is merged into the SAME signal a lock loss uses: from `fn`'s point of
  // view both mean "stop between units of work and return". `signal.reason` says
  // which. Registered with `once` so a long-lived caller signal doesn't retain
  // this controller after the run.
  const onExternalAbort = (): void => {
    if (!lost.signal.aborted) lost.abort('shutdown' satisfies LeaderLockAbortReason);
  };
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let heartbeat: NodeJS.Timeout | undefined;
  if (typeof redis.eval === 'function') {
    const evalFn = redis.eval.bind(redis);
    heartbeat = setInterval(() => {
      evalFn(EXTEND_IF_OWNER, 1, key, token, ttlMs).then((extended) => {
        if (Number(extended) !== 1 && !lost.signal.aborted) {
          lockLogger.warn('Leader lock lost mid-run (another holder, or the key expired)', { key });
          emitCounter('leader_lock_lost_total', { key });
          lost.abort('lock-lost' satisfies LeaderLockAbortReason);
        }
      }).catch((err) => {
        // A blip: the next beat retries; the TTL still covers this interval.
        lockLogger.debug('Leader lock heartbeat failed', { key, error: errorMessage(err) });
      });
    }, Math.max(1, Math.floor(ttlMs / 3)));
    heartbeat.unref?.();
  }

  try {
    await fn({ signal: lost.signal });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    opts.signal?.removeEventListener('abort', onExternalAbort);
    // Release only if the lock is still ours — if our run overran the TTL and
    // another holder took over, releasing here would free their lock early.
    // Prefer an atomic CAS (Lua); fall back to get-then-del for clients without
    // eval (the small non-atomic window is TTL-bounded).
    try {
      if (typeof redis.eval === 'function') {
        await redis.eval(RELEASE_IF_OWNER, 1, key, token);
      } else if ((await redis.get(key)) === token) {
        await redis.del(key);
      }
    } catch {
      // Best-effort: the TTL expires the lock regardless.
    }
  }
  return true;
}

/**
 * A `LockRedis` backed by the shared env Redis client (see env-redis.ts) — the leader-lock counterpart to `createEnvRedisAuditSpool` /
 * `createEnvRedisTokenRevocationStore`, for a service that has no BullMQ client to
 * borrow. Returns `null` when Redis isn't configured, so a caller can degrade to
 * running on every pod (the atomic guards it wraps must still make that safe).
 * The client is a real ioredis instance; ioredis exposes `set`/`get`/`del`/`eval`,
 * satisfying `LockRedis` including the atomic CAS release.
 */
export function createEnvRedisLock(): LockRedis | null {
  const inst = createEnvRedisClient<LockRedis>('leader-lock');
  if (inst) lockLogger.info('Redis leader-lock client initialized');
  return inst;
}

// One env-configured lock client per process, shared by every scheduler that
// asks for a lock without supplying its own client. Reference-counted so the
// connection is closed when the last such scheduler stops.
let sharedLock: LockRedis | null | undefined;
let sharedLockUsers = 0;

/** Take a reference on the shared env lock client (`null` when Redis isn't configured). */
export function acquireSharedEnvLock(): LockRedis | null {
  if (sharedLock === undefined) sharedLock = createEnvRedisLock();
  sharedLockUsers++;
  return sharedLock;
}

/** Drop a reference taken by {@link acquireSharedEnvLock}; the last one closes the client. */
export async function releaseSharedEnvLock(): Promise<void> {
  if (sharedLockUsers === 0) return;
  sharedLockUsers--;
  if (sharedLockUsers > 0) return;
  const client = sharedLock;
  sharedLock = undefined;
  await closeLeaderLock(client);
}
