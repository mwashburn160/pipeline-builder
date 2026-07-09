// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';

/**
 * Minimal Redis client surface needed for a leader lock (a subset of ioredis).
 * `set` is variadic so callers can pass `'PX', ttl, 'NX'`.
 */
export interface LockRedis {
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  /** Optional Lua eval (ioredis has it). When present, release uses an atomic
   *  compare-and-delete so a lapsed holder can't free a successor's lock. */
  eval?(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>;
}

/** Atomic "delete only if I still own it" — closes the get-then-del race where
 *  the lock expires and is re-acquired between the two calls. */
const RELEASE_IF_OWNER =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/**
 * Run `fn` only if this process wins a short-lived distributed lock — the
 * across-pods "single runner" guard for periodic jobs (digest flushes, etc.).
 *
 * Uses `SET key token NX PX ttl`, so exactly one holder runs per window and the
 * lock auto-expires if that holder dies mid-run (no stuck lock). The lock is
 * released on completion, but only if we still own it — a slower predecessor
 * never deletes a successor's lock. `ttlMs` should comfortably exceed one run.
 *
 * @returns true if we held the lock and ran `fn`; false if another holder did.
 */
export async function withLeaderLock(
  redis: LockRedis,
  key: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return false;

  try {
    await fn();
  } finally {
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
