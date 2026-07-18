// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight caching service with TTL support.
 *
 * Two implementations:
 * - In-memory (default): true-LRU Map cache, no external dependencies
 * - Redis: When a Redis client is provided, uses Redis for cross-process caching
 *
 * Design:
 * - All operations are fail-safe: cache misses/errors return null, never throw
 * - JSON serialization for Redis; the in-memory backend deep-clones on read so
 *   both backends return an independent copy (mutating a result is always safe)
 * - `getOrSet` is single-flight: concurrent misses share one factory() call
 * - Key namespace prefixing to avoid collisions between services
 */


/**
 * Cache entry with value and expiration time.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number; // Unix timestamp in ms
}

/**
 * Deep-clone a value so the in-memory backend hands back an INDEPENDENT copy on
 * every read — matching the Redis backend, which returns a fresh `JSON.parse`
 * clone each time. Without this the in-memory cache returns the same stored
 * object reference, so a consumer mutating a "cached" object silently corrupts
 * the shared cache (a footgun that only bites under the memory backend).
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
 * Minimal Redis-like client interface (subset of ioredis).
 * Services pass their own Redis client instance.
 */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  /** SCAN-based iteration (preferred over KEYS for production). */
  scanStream?(options: { match: string; count?: number }): NodeJS.ReadableStream;
}

export interface CacheConfig {
  /** Key prefix for namespace isolation (e.g., 'plugin:', 'compliance:') */
  prefix: string;
  /** Default TTL in seconds */
  defaultTtlSeconds: number;
  /** Max entries for in-memory cache (default 1000) */
  maxEntries?: number;
  /** Optional Redis client — uses in-memory cache if not provided */
  redis?: RedisCacheClient;
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
  private readonly redis?: RedisCacheClient;

  /** Cache metrics — tracks hits, misses, and invalidations. */
  readonly metrics = { hits: 0, misses: 0, sets: 0, invalidations: 0 };

  constructor(config: CacheConfig) {
    this.prefix = config.prefix;
    this.defaultTtlMs = config.defaultTtlSeconds * 1000;
    this.maxEntries = config.maxEntries ?? 1000;
    this.redis = config.redis;
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * Get a cached value. Returns null on miss or error.
   *
   * The returned value is an INDEPENDENT deep copy — mutating it never affects
   * the cached entry (the in-memory backend clones on read for parity with
   * Redis, which returns a fresh JSON clone). Callers may still treat results as
   * immutable, but doing so is no longer load-bearing for cache integrity.
   */
  async get<T>(key: string): Promise<T | null> {
    const fk = this.fullKey(key);

    try {
      if (this.redis) {
        const raw = await this.redis.get(fk);
        if (!raw) { this.metrics.misses++; return null; }
        this.metrics.hits++;
        return JSON.parse(raw) as T;
      }

      // In-memory
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
   * @param value - Value to cache (must be JSON-serializable for Redis)
   * @param ttlSeconds - TTL override (uses default if not provided)
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const fk = this.fullKey(key);
    const ttl = ttlSeconds ?? this.defaultTtlMs / 1000;

    try {
      this.metrics.sets++;
      if (this.redis) {
        await this.redis.set(fk, JSON.stringify(value), 'EX', ttl);
        return;
      }

      // In-memory — a write counts as a use, so drop any existing entry first
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
    const fk = this.fullKey(key);

    try {
      if (this.redis) {
        await this.redis.del(fk);
        return;
      }
      this.memory.delete(fk);
    } catch {
      // Cache delete failure is non-fatal
    }
  }

  /**
   * Invalidate all keys matching a pattern (e.g., 'org123:*').
   * Uses SCAN for Redis (non-blocking) with KEYS fallback, or regex for in-memory.
   */
  async invalidatePattern(pattern: string): Promise<number> {
    const fp = this.fullKey(pattern);

    try {
      if (this.redis) {
        const keys = this.redis.scanStream
          ? await this.scanKeys(fp)
          : await this.redis.keys(fp);
        if (keys.length > 0) {
          await this.redis.del(...keys);
          this.metrics.invalidations += keys.length;
        }
        return keys.length;
      }

      // In-memory — match glob-style pattern. Escape regex metacharacters first
      // so a literal `.`/`(`/`[` in a key prefix (e.g. `org:v1.2:*`) can't
      // over-match or throw (a throw here is swallowed → nothing invalidated →
      // stale reads); only `*` is treated as a wildcard.
      const regex = new RegExp('^' + fp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$');
      let deleted = 0;
      for (const key of this.memory.keys()) {
        if (regex.test(key)) {
          this.memory.delete(key);
          deleted++;
        }
      }
      this.metrics.invalidations += deleted;
      return deleted;
    } catch {
      return 0;
    }
  }

  /** Collect keys via Redis SCAN (non-blocking alternative to KEYS). */
  private scanKeys(pattern: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const stream = this.redis!.scanStream!({ match: pattern, count: 100 });
      const keys: string[] = [];
      stream.on('data', (batch: string[]) => keys.push(...batch));
      stream.once('end', () => resolve(keys));
      stream.once('error', reject);
    });
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
    // Coalesce concurrent cold callers onto a single factory() invocation.
    const existing = this.inflight.get(fk);
    if (existing) return existing as Promise<T>;

    const flight = (async () => {
      const value = await factory();
      await this.set(key, value, ttlSeconds);
      return value;
    })();
    this.inflight.set(fk, flight);
    try {
      return await flight;
    } finally {
      this.inflight.delete(fk);
    }
  }

  /**
   * Clear all entries (useful for testing).
   */
  async clear(): Promise<void> {
    if (this.redis) {
      await this.invalidatePattern('*');
    } else {
      this.memory.clear();
    }
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
 * @param redis - Optional Redis client for cross-process caching
 */
export function createCacheService(
  prefix: string,
  defaultTtlSeconds = 300,
  redis?: RedisCacheClient,
): CacheService {
  return new CacheService({ prefix, defaultTtlSeconds, redis });
}
