// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight caching service with TTL support.
 *
 * Storage is a per-process true-LRU Map (no external dependencies).
 *
 * Cross-replica invalidation: every service runs several
 * replicas (HPA), each with its OWN in-memory cache. An invalidation performed on
 * one pod (`del` / `invalidatePattern` / `clear`) is broadcast over Redis pub/sub
 * ({@link CacheInvalidationBus}, wired from the ambient Redis env by default) and
 * applied by every other pod, so a write on pod A can't leave pod B serving the
 * stale entry until its TTL lapses. A pod whose subscriber (re)connects flushes
 * its local cache — it may have missed invalidations while disconnected — and a
 * `getOrSet` whose factory raced an invalidation does not cache its result.
 *
 * Design:
 * - All operations are fail-safe: cache misses/errors return null, never throw
 * - Reads deep-clone, so every caller gets an independent copy (mutating a
 *   result is always safe)
 * - `getOrSet` is single-flight: concurrent misses share one factory() call
 * - Key namespace prefixing to avoid collisions between services
 */

import { randomUUID } from 'crypto';

import { createEnvRedisClient } from './env-redis.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('cache-service');

/**
 * Cache entry with value and expiration time.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number; // Unix timestamp in ms
}

/**
 * Deep-clone a value so the cache hands back an INDEPENDENT copy on every read.
 * Without this it returns the same stored object reference, so a consumer
 * mutating a "cached" object silently corrupts the shared cache.
 *
 * Primitives are returned as-is. Prefers the structured-clone algorithm; falls
 * back to a JSON round-trip on older runtimes or exotic values.
 */
function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/**
 * Minimal Redis key/value client surface (subset of ioredis) shared by the
 * token-revocation publisher/reader and platform's Redis helpers.
 */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

export interface CacheConfig {
  /** Key prefix for namespace isolation (e.g., 'plugin:', 'compliance:') */
  prefix: string;
  /** Default TTL in seconds */
  defaultTtlSeconds: number;
  /** Max entries for the cache (default 1000) */
  maxEntries?: number;
  /**
   * Cross-replica invalidation bus. Omit to use the shared env-Redis bus (null
   * when Redis isn't configured → single-process semantics); pass `null` to
   * disable explicitly.
   */
  invalidationBus?: CacheInvalidationBus | null;
}

/** One invalidation broadcast to every replica. */
export interface CacheInvalidationMessage {
  /** Id of the CacheService instance that invalidated (it ignores its own echo). */
  origin: string;
  /** The cache namespace (`CacheConfig.prefix`) the invalidation applies to. */
  prefix: string;
  op: 'del' | 'pattern' | 'clear';
  /** Un-prefixed key (`del`) or glob pattern (`pattern`). */
  key?: string;
}

/** Transport that fans cache invalidations out to every replica. */
export interface CacheInvalidationBus {
  /** Fire-and-forget broadcast. Never throws. */
  publish(msg: CacheInvalidationMessage): void;
  /**
   * Register handlers. `onMessage` receives every broadcast (including this
   * process's own); `onResync` fires whenever the subscription is (re)established,
   * i.e. whenever invalidations may have been missed.
   */
  subscribe(onMessage: (msg: CacheInvalidationMessage) => void, onResync: () => void): void;
}

/** Minimal ioredis pub/sub surface the env bus needs. */
export interface RedisInvalidationClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: string, cb: (...args: any[]) => void): unknown;
  duplicate(): RedisInvalidationClient;
  status?: string;
}

const CACHE_INVALIDATION_CHANNEL = 'cache:invalidate';

/**
 * Redis pub/sub invalidation bus. PUBLISH on the given client; SUBSCRIBE on a
 * `duplicate()` (a subscribed ioredis connection can't run other commands).
 *
 * The SUBSCRIBE is issued on every `ready` (initial connect AND each reconnect)
 * rather than once at construction: the env client runs without an offline
 * queue, so a subscribe issued before the connection is up is rejected and would
 * never be retried. Each `ready` also triggers `onResync` so every cache flushes
 * whatever it may have missed while disconnected.
 */
export function createRedisCacheInvalidationBus(publisher: RedisInvalidationClient): CacheInvalidationBus {
  const subscriber = publisher.duplicate();
  const messageHandlers: Array<(msg: CacheInvalidationMessage) => void> = [];
  const resyncHandlers: Array<() => void> = [];

  const resync = (): void => {
    for (const h of resyncHandlers) {
      try { h(); } catch { /* isolated */ }
    }
  };
  const doSubscribe = (): void => {
    void Promise.resolve(subscriber.subscribe(CACHE_INVALIDATION_CHANNEL))
      .then(() => resync())
      .catch((err: unknown) => {
        emitCounter('cache_invalidation_subscribe_failed_total', {});
        logger.warn('Cache invalidation subscribe failed; will retry on next reconnect', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  subscriber.on('message', (channel: string, raw: string) => {
    if (channel !== CACHE_INVALIDATION_CHANNEL) return;
    let msg: CacheInvalidationMessage;
    try {
      msg = JSON.parse(raw) as CacheInvalidationMessage;
    } catch {
      return;
    }
    for (const h of messageHandlers) {
      try { h(msg); } catch { /* one cache can't break the others */ }
    }
  });
  subscriber.on('ready', doSubscribe);
  subscriber.on('error', (e: unknown) =>
    logger.warn('Cache invalidation subscriber error', { error: e instanceof Error ? e.message : String(e) }));
  if (subscriber.status === 'ready') doSubscribe();

  return {
    publish(msg) {
      void Promise.resolve()
        .then(() => publisher.publish(CACHE_INVALIDATION_CHANNEL, JSON.stringify(msg)))
        .catch((err: unknown) => {
          emitCounter('cache_invalidation_publish_failed_total', { prefix: msg.prefix });
          logger.warn('Cache invalidation publish failed (other replicas keep the entry until TTL)', {
            prefix: msg.prefix, op: msg.op, error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    subscribe(onMessage, onResync) {
      messageHandlers.push(onMessage);
      resyncHandlers.push(onResync);
    },
  };
}

// undefined = not yet attempted; null = attempted, Redis not configured.
let envInvalidationBus: CacheInvalidationBus | null | undefined;

/** Process-wide invalidation bus from the ambient Redis env (null without Redis). */
function getEnvCacheInvalidationBus(): CacheInvalidationBus | null {
  if (envInvalidationBus === undefined) {
    const client = createEnvRedisClient<RedisInvalidationClient>('cache-invalidation');
    envInvalidationBus = client ? createRedisCacheInvalidationBus(client) : null;
  }
  return envInvalidationBus;
}

/**
 * Cache service with get/set/del operations and automatic TTL expiry.
 *
 * @example
 * ```typescript
 * const cache = new CacheService({ prefix: 'plugin:', defaultTtlSeconds: 300 });
 *
 * // Set with default TTL
 * await cache.set('org123:list', plugins);
 *
 * // Get (returns null on miss)
 * const cached = await cache.get<Plugin[]>('org123:list');
 *
 * // Invalidate
 * await cache.del('org123:list');
 *
 * // Invalidate by pattern
 * await cache.invalidatePattern('org123:*');
 * ```
 */
export class CacheService {
  private memory = new Map<string, CacheEntry<unknown>>();
  /**
   * In-flight `getOrSet` factory promises, keyed by full cache key. Coalesces
   * concurrent cold callers onto a single `factory()` invocation (single-flight
   * / stampede protection); entries are cleared once the promise settles.
   */
  private inflight = new Map<string, Promise<unknown>>();
  private readonly prefix: string;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly bus: CacheInvalidationBus | null;
  private readonly instanceId = randomUUID();
  /**
   * Bumped on EVERY invalidation (local or remote). `getOrSet` only caches a
   * factory result if no invalidation happened while the factory ran — otherwise
   * it could re-cache a value read before the write that invalidated it.
   */
  private generation = 0;

  /** Cache metrics — tracks hits, misses, and invalidations. */
  readonly metrics = { hits: 0, misses: 0, sets: 0, invalidations: 0 };

  constructor(config: CacheConfig) {
    this.prefix = config.prefix;
    this.defaultTtlMs = config.defaultTtlSeconds * 1000;
    this.maxEntries = config.maxEntries ?? 1000;
    this.bus = config.invalidationBus === undefined ? getEnvCacheInvalidationBus() : config.invalidationBus;
    this.bus?.subscribe(
      (msg) => {
        if (msg.origin === this.instanceId || msg.prefix !== this.prefix) return;
        this.applyLocalInvalidation(msg.op, msg.key);
      },
      () => this.applyLocalInvalidation('clear'),
    );
  }

  /** Broadcast an invalidation to the other replicas. */
  private broadcast(op: CacheInvalidationMessage['op'], key?: string): void {
    this.bus?.publish({ origin: this.instanceId, prefix: this.prefix, op, ...(key !== undefined && { key }) });
  }

  /** Apply an invalidation to THIS process's in-memory entries. Returns the count removed. */
  private applyLocalInvalidation(op: CacheInvalidationMessage['op'], key?: string): number {
    this.generation++;
    if (op === 'clear') {
      const n = this.memory.size;
      this.memory.clear();
      return n;
    }
    if (op === 'del') {
      return this.memory.delete(this.fullKey(key ?? '')) ? 1 : 0;
    }
    // Glob pattern. Escape regex metacharacters first so a literal `.`/`(`/`[`
    // in a key prefix (e.g. `org:v1.2:*`) can't over-match or throw (a throw
    // here would leave entries stale); only `*` is treated as a wildcard.
    const fp = this.fullKey(key ?? '');
    const regex = new RegExp('^' + fp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$');
    let deleted = 0;
    for (const k of this.memory.keys()) {
      if (regex.test(k)) {
        this.memory.delete(k);
        deleted++;
      }
    }
    return deleted;
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * Get a cached value. Returns null on miss or error.
   *
   * The returned value is an INDEPENDENT deep copy — mutating it never affects
   * the cached entry.
   */
  async get<T>(key: string): Promise<T | null> {
    const fk = this.fullKey(key);

    try {
      const entry = this.memory.get(fk);
      if (!entry) { this.metrics.misses++; return null; }
      if (Date.now() > entry.expiresAt) {
        this.memory.delete(fk);
        this.metrics.misses++;
        return null;
      }
      // LRU touch: delete + re-insert moves this key to the newest position
      // (Map preserves insertion order), so `set`'s oldest-first eviction is a
      // true least-recently-USED eviction rather than first-inserted (FIFO).
      this.memory.delete(fk);
      this.memory.set(fk, entry);
      this.metrics.hits++;
      // Clone so a caller mutating the result can't corrupt the shared entry.
      return cloneValue(entry.value) as T;
    } catch {
      this.metrics.misses++;
      return null;
    }
  }

  /**
   * Set a cached value with optional TTL override.
   *
   * @param key - Cache key (prefix is added automatically)
   * @param value - Value to cache
   * @param ttlSeconds - TTL override (uses default if not provided)
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const fk = this.fullKey(key);
    const ttl = ttlSeconds ?? this.defaultTtlMs / 1000;

    try {
      this.metrics.sets++;
      // A write counts as a use, so drop any existing entry first
      // and re-insert below as the newest (Map preserves insertion order). This
      // keeps the Map ordered oldest-USED → newest-USED so the eviction below is
      // true LRU, and avoids evicting a victim when merely updating a key.
      this.memory.delete(fk);
      if (this.memory.size >= this.maxEntries) {
        const firstKey = this.memory.keys().next().value;
        if (firstKey) this.memory.delete(firstKey);
      }

      this.memory.set(fk, {
        value,
        expiresAt: Date.now() + ttl * 1000,
      });
    } catch {
      // Cache set failure is non-fatal
    }
  }

  /**
   * Delete a cached value.
   */
  async del(key: string): Promise<void> {
    try {
      this.applyLocalInvalidation('del', key);
      this.broadcast('del', key);
    } catch {
      // Cache delete failure is non-fatal
    }
  }

  /**
   * Invalidate all keys matching a pattern (e.g., 'org123:*').
   * Only `*` is a wildcard.
   */
  async invalidatePattern(pattern: string): Promise<number> {
    try {
      // Apply locally, then fan out to the other replicas.
      const deleted = this.applyLocalInvalidation('pattern', pattern);
      this.broadcast('pattern', pattern);
      this.metrics.invalidations += deleted;
      return deleted;
    } catch {
      return 0;
    }
  }

  /**
   * Get or compute: returns cached value if available, otherwise calls the
   * factory function, caches the result, and returns it.
   *
   * Single-flight / stampede protection: when N callers miss concurrently for
   * the same key, only ONE `factory()` runs — the rest await its shared promise.
   * The in-flight entry is cleared once it settles (success or failure), so a
   * failed factory doesn't poison later calls.
   *
   * @param key - Cache key
   * @param factory - Async function to compute the value on cache miss
   * @param ttlSeconds - Optional TTL override
   * @returns The cached or computed value
   */
  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const fk = this.fullKey(key);
    // Coalesce concurrent cold callers onto a single factory() invocation. The
    // in-flight promise resolves to the RAW value; each awaiter (the primary
    // caller below AND every coalesced caller here) clones it INDEPENDENTLY.
    // Cloning inside the flight instead would hand one shared clone to all N
    // coalesced callers, so one caller mutating its "independent" result would
    // corrupt what the others read — the exact footgun get()'s clone-on-read
    // prevents.
    const existing = this.inflight.get(fk) as Promise<T> | undefined;
    if (existing) return cloneValue(await existing);

    const generationAtStart = this.generation;
    const flight = (async () => {
      const value = await factory();
      // An invalidation (here or on another replica) landed while the factory
      // ran: its read may predate that write, so don't cache it.
      if (this.generation === generationAtStart) await this.set(key, value, ttlSeconds);
      return value;
    })();
    this.inflight.set(fk, flight);
    try {
      return cloneValue(await flight);
    } finally {
      this.inflight.delete(fk);
    }
  }

  /**
   * Clear all entries (useful for testing).
   */
  async clear(): Promise<void> {
    this.applyLocalInvalidation('clear');
    this.broadcast('clear');
  }

  /** Current in-memory cache size (for diagnostics). */
  get size(): number {
    return this.memory.size;
  }
}

/**
 * Create a cache service instance.
 *
 * @param prefix - Namespace prefix (e.g., 'compliance:', 'plugin:')
 * @param defaultTtlSeconds - Default TTL in seconds (default 300 = 5 min)
 */
export function createCacheService(prefix: string, defaultTtlSeconds = 300): CacheService {
  return new CacheService({ prefix, defaultTtlSeconds });
}
