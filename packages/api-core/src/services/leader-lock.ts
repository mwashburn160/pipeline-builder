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
}

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
    // another holder took over, deleting here would free their lock early.
    try {
      if ((await redis.get(key)) === token) await redis.del(key);
    } catch {
      // Best-effort: the TTL expires the lock regardless.
    }
  }
  return true;
}
