// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fleet-wide semaphores for remediation work (Redis sorted sets: member = the
 * holder, score = its lease expiry). A crashed holder's lease lapses on its
 * own; a live holder renews it. Two pools:
 *  - `tenant`: PLUGIN_REMEDIATION_CONCURRENCY remediation jobs at once;
 *  - `base`:   PLUGIN_REMEDIATION_BASE_CONCURRENCY shared-base rebuilds at once.
 */

export interface SemaphoreRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
}

export const SEMAPHORE_KEYS = { tenant: 'plugin:remediation:running', base: 'plugin:remediation:base-running' } as const;
export const SEMAPHORE_LEASE_MS = 15 * 60_000;

/** Drop expired leases, then admit `member` when fewer than `cap` hold one (or it already does). */
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
  return 1
end
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[4]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
  return 1
end
return 0`;

export async function tryAcquire(redis: SemaphoreRedis, pool: keyof typeof SEMAPHORE_KEYS, member: string, cap: number, now = Date.now()): Promise<boolean> {
  const got = await redis.eval(ACQUIRE, 1, SEMAPHORE_KEYS[pool], now, now + SEMAPHORE_LEASE_MS, member, cap);
  return Number(got) === 1;
}

export async function release(redis: SemaphoreRedis, pool: keyof typeof SEMAPHORE_KEYS, member: string): Promise<void> {
  await redis.zrem(SEMAPHORE_KEYS[pool], member);
}

/** Renew a lease every third of its length until the returned stop function is called. */
export function keepLease(redis: SemaphoreRedis, pool: keyof typeof SEMAPHORE_KEYS, member: string): () => void {
  const t = setInterval(() => { void redis.zadd(SEMAPHORE_KEYS[pool], Date.now() + SEMAPHORE_LEASE_MS, member).catch(() => undefined); }, SEMAPHORE_LEASE_MS / 3);
  t.unref();
  return () => clearInterval(t);
}
