// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-pod pending-state store for the short-lived CSRF `state` (+ bound
 * metadata) that the OAuth and per-org SSO login flows mint on initiate and
 * consume-once on callback.
 *
 * WHY: the OAuth/SSO controllers previously held these in a process-local `Map`.
 * Under multiple replicas the initiate (that mints the state) and the callback
 * (that consumes it) routinely land on DIFFERENT pods, so the callback pod never
 * sees the state and login fails — at `maxReplicas: 5` roughly 80% of the time.
 * Backing the state with the shared env Redis makes it visible fleet-wide.
 *
 * Semantics:
 *   - `put(state, value)` writes the entry with a short PX TTL (auto-expiry — no
 *     sweep needed on the Redis path).
 *   - `consume(state)` returns the value ONCE and deletes it (consume-once, so a
 *     replayed state is rejected). It deletes on ANY lookup, valid or not, to
 *     match the controllers' anti-probing contract.
 *   - When Redis is UNSET (`REDIS_URL` absent) the store degrades to a
 *     process-local Map with the same TTL sweep + bounded eviction the
 *     controllers used before — single-pod deployments keep working unchanged.
 *   - Fail-safe: a Redis error on `put` falls back to the local Map; a Redis
 *     error on `consume` rejects that one attempt (the user simply retries),
 *     which is the safe direction for a CSRF token.
 *
 * Reuses `getRedisClient()` — the SAME env Redis client the platform already
 * uses to publish session-revocation entries — so no new connection/config.
 */

import { getRedisClient } from '../utils/redis-client.js';

/** ioredis exposes an atomic GETDEL (Redis 6.2+); use it for true consume-once
 *  when present, else fall back to GET+DEL (a negligible, TTL-bounded race). */
interface MaybeGetDel {
  getdel?(key: string): Promise<string | null>;
}

export interface PendingStateStore<T> {
  put(state: string, value: T): Promise<void>;
  consume(state: string): Promise<T | null>;
  /** Test-only: clear the in-memory fallback map. */
  _resetForTests(): void;
  /** Test-only: stop the fallback sweep timer. */
  _stopSweepForTests(): void;
}

export interface PendingStateStoreOptions {
  /** Redis key prefix (namespaces this store's keys). */
  prefix: string;
  /** Entry lifetime in ms (Redis PX + in-memory sweep threshold). */
  ttlMs: number;
  /** How often the in-memory fallback sweeps expired entries. */
  cleanupIntervalMs: number;
  /** Cap on the in-memory fallback map (bounded eviction when full). */
  maxEntries: number;
}

export function createPendingStateStore<T>(opts: PendingStateStoreOptions): PendingStateStore<T> {
  const { prefix, ttlMs, cleanupIntervalMs, maxEntries } = opts;
  const mem = new Map<string, { value: T; createdAt: number }>();

  // `.unref()` so this background sweep never keeps Node alive in tests/workers.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [entryKey, { createdAt }] of mem) {
      if (now - createdAt > ttlMs) mem.delete(entryKey);
    }
  }, cleanupIntervalMs);
  sweep.unref();

  function evictOldestIfFull(): void {
    if (mem.size < maxEntries) return;
    const toEvict = Math.max(1, Math.floor(maxEntries * 0.1));
    const it = mem.keys();
    for (let i = 0; i < toEvict; i++) {
      const oldestKey = it.next().value;
      if (oldestKey) mem.delete(oldestKey);
    }
  }

  function key(state: string): string {
    return `${prefix}${state}`;
  }

  return {
    async put(state: string, value: T): Promise<void> {
      const redis = await getRedisClient();
      if (redis) {
        try {
          // ioredis-style variadic SET with millisecond expiry.
          await redis.set(key(state), JSON.stringify(value), 'PX', ttlMs);
          return;
        } catch {
          // Fall through to the local map so an in-flight Redis blip on initiate
          // still lets a same-pod callback succeed.
        }
      }
      evictOldestIfFull();
      mem.set(state, { value, createdAt: Date.now() });
    },

    async consume(state: string): Promise<T | null> {
      const redis = await getRedisClient();
      if (redis) {
        try {
          const k = key(state);
          const gd = redis as unknown as MaybeGetDel;
          let raw: string | null;
          if (typeof gd.getdel === 'function') {
            raw = await gd.getdel(k);
          } else {
            raw = await redis.get(k);
            await redis.del(k); // consume-once
          }
          if (raw != null) return JSON.parse(raw) as T;
          // Redis miss: fall through to check the local-map fallback, covering a
          // state that landed in the map because Redis was briefly down on `put`.
        } catch {
          // Redis error: reject this attempt (safe direction); still check mem.
        }
      }
      const entry = mem.get(state);
      mem.delete(state); // consume-once
      if (!entry) return null;
      if (Date.now() - entry.createdAt > ttlMs) return null;
      return entry.value;
    },

    _resetForTests(): void {
      mem.clear();
    },

    _stopSweepForTests(): void {
      clearInterval(sweep);
    },
  };
}
